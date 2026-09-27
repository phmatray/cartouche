/**
 * Live translate while a game runs (loaded only once the player turns it on): sampled frames go to the reader
 * worker when their tiles changed, finished text boxes get translated (cache, then the chosen provider), and
 * the store tells the overlay what to show.
 */
import { H, LINES_OFF, LINE_LEN, META_LEN, VRAM_OFF } from '../neural/trace.ts';
import { hasKana, passage, type Box } from './ocr.ts';
import type { FromReader, ToReader } from './worker.ts';
import { chromeStatus, chromeTranslator, claudeTranslate } from './providers.ts';
import { confirm, corrections, settle, settleState } from './session.ts';
import { getGlyphs, getLine, putGlyphs, putLine } from './db.ts';
import { useTranslate, type LiveBox } from './store.ts';

/**
 * Two metas show the same BG and window text when every scanline's registers and VRAM match: sprites,
 * palettes and the frame number don't count, so a character walking about doesn't cost a read.
 */
function sameText(a: Uint8Array, b: Uint8Array): boolean {
  for (let y = 0; y < H; y++) for (let i = LINES_OFF + y * LINE_LEN, e = i + 11; i < e; i++) if (a[i] !== b[i]) return false;
  for (let i = VRAM_OFF; i < META_LEN; i++) if (a[i] !== b[i]) return false;
  return true;
}

export class Live {
  private worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  private last: Uint8Array | null = null;
  private busy = false;
  private pending: Uint8Array | null = null;
  private boxes: Box[] = [];
  private settled = settleState();
  private learned: Record<string, string> = {};
  private guesses = new Map<string, { char: string; n: number }>();
  /** Recent originals, for Claude's context. */
  private history: string[] = [];
  private job = 0;
  private dead = false;
  private urgent = false;
  private readonly gameId: string;
  private readonly title: string;

  constructor(gameId: string, title: string) {
    this.gameId = gameId;
    this.title = title;
    this.worker.onmessage = (e: MessageEvent<FromReader>) => this.onReader(e.data);
    getGlyphs(gameId).then((map) => { this.learned = map; this.send({ type: 'learned', map }); });
    this.checkChrome();
  }

  dispose() {
    this.dead = true;
    this.worker.terminate();
    useTranslate.setState({ boxes: [], seen: [], ready: false });
  }

  /** A traced frame's meta (a view valid until the next frame: copied here). */
  feed(meta: Uint8Array) {
    const now = performance.now();
    if (this.last && sameText(this.last, meta)) { this.tick(now); return; }
    const copy = meta.slice(0, META_LEN);
    this.last = copy;
    if (this.busy) { this.pending = copy; return; }
    this.read(copy);
  }

  /** Teach: `char` for this bitmap from now on in this game ('' = not text); null forgets it. */
  teach(key: string, char: string | null) {
    if (char === null) delete this.learned[key]; else this.learned[key] = char;
    this.learned = { ...this.learned };
    putGlyphs(this.gameId, this.learned);
    this.send({ type: 'learned', map: this.learned });
    this.again();
  }

  forgetAll() {
    this.learned = {};
    putGlyphs(this.gameId, {});
    this.send({ type: 'learned', map: {} });
    this.again();
  }

  /** Read the screen again and translate it at once (the game may be paused: no settling to wait for). */
  private again() {
    this.urgent = true;
    if (this.last) this.read(this.last);
  }

  async checkChrome() {
    useTranslate.setState({ chrome: await chromeStatus('ja', useTranslate.getState().lang) });
  }

  /** The language changed, or the provider or its key: translate what is on screen again. */
  refresh() {
    this.history = [];
    this.checkChrome();
    // Right away, even paused: the boxes on screen were read already.
    const text = this.boxes.map(passage).join('\n');
    this.settled = { text, since: performance.now(), done: text };
    if (text) this.translateAll(this.boxes);
  }

  private send(m: ToReader, transfer?: Transferable[]) { this.worker.postMessage(m, transfer ?? []); }

  private read(meta: Uint8Array) {
    this.busy = true;
    const copy = meta.slice();
    this.send({ type: 'read', meta: copy.buffer }, [copy.buffer]);
  }

  private onReader(m: FromReader) {
    if (m.type === 'ready') { useTranslate.setState({ ready: true }); return; }
    if (m.type === 'error') { console.warn('Live translate:', m.message); return; }
    this.busy = false;
    this.boxes = m.boxes;
    const text = m.boxes.map(passage).join('\n');
    const shown = useTranslate.getState().boxes;
    // New text that doesn't continue what the slips show: take them down until it settles.
    if (!text || (shown.length && !text.startsWith(this.settled.done))) useTranslate.setState({ boxes: [] });
    const last = m.boxes[m.boxes.length - 1];
    if (last) useTranslate.setState({ seen: last.glyphs.map(({ key, char }) => ({ key, char })) });
    if (this.urgent && text) {
      this.urgent = false;
      this.settled = { text, since: performance.now(), done: text };
      this.translateAll(m.boxes);
    } else this.tick(performance.now());
    if (this.pending) { const p = this.pending; this.pending = null; this.read(p); }
  }

  private tick(now: number) {
    const text = this.boxes.map(passage).join('\n');
    if (settle(this.settled, text, now)) this.translateAll(this.boxes);
  }

  private async translateAll(boxes: Box[]) {
    const job = ++this.job;
    const s = useTranslate.getState();
    const live: LiveBox[] = [];
    for (const b of boxes) {
      const source = passage(b), sourceLang = hasKana(source) ? 'ja' : 'en';
      if (sourceLang === s.lang) continue; // already in the player's language
      live.push({ x: b.x, y: b.y, w: b.w, h: b.h, source, sourceLang, state: 'translating' });
    }
    useTranslate.setState({ boxes: live });
    await Promise.all(live.map(async (lb) => {
      const done = (p: Partial<LiveBox>) => {
        if (this.dead || job !== this.job) return;
        Object.assign(lb, p);
        useTranslate.setState({ boxes: [...live] });
      };
      try { done(await this.translate(lb, boxes.find((b) => passage(b) === lb.source)!)); } catch (e) {
        done({ state: 'error', error: e instanceof Error ? e.message : String(e) });
      }
    }));
    for (const lb of live) this.history = [...this.history, lb.source].slice(-6);
  }

  private async translate(lb: LiveBox, box: Box): Promise<Partial<LiveBox>> {
    const { lang, provider, claudeKey, chrome } = useTranslate.getState();
    const cached = await getLine(this.gameId, lang, lb.source);
    if (cached) return { state: 'done', translation: cached.translation, by: 'cache' };
    // 'auto': Chrome once its model is on this device, else Claude with a key, else Chrome's model starts
    // downloading (the text shows as read meanwhile), else the text as read.
    const fetching = chrome === 'downloadable' || chrome === 'downloading';
    const useChrome = provider === 'chrome' || (provider === 'auto' && (chrome === 'available' || (!claudeKey && fetching)));
    const useClaude = !useChrome && (provider === 'claude' || (provider === 'auto' && !!claudeKey));
    if (useChrome) {
      if (chrome === 'missing' || chrome === 'unavailable' || chrome === 'checking') throw new Error('This browser has no built-in translator for this language');
      if (chrome !== 'available') {
        // The first download needs a user gesture (the toggle's click starts it); until it's done, show the text as read.
        chromeTranslator(lb.sourceLang, lang, (p) => useTranslate.setState({ chrome: 'downloading', chromeProgress: p }))
          .then(() => { useTranslate.setState({ chrome: 'available' }); this.refresh(); }, () => {});
        return { state: 'raw', note: 'Chrome is downloading its translation model' };
      }
      const t = await chromeTranslator(lb.sourceLang, lang);
      const translation = await t.translate(lb.source);
      putLine(this.gameId, lang, lb.source, translation, 'chrome');
      return { state: 'done', translation, by: 'chrome' };
    }
    if (useClaude) {
      if (!claudeKey) throw new Error('Add your Claude API key in the Manual');
      const r = await claudeTranslate({ key: claudeKey, text: lb.source, src: lb.sourceLang, dst: lang, title: this.title, previous: this.history })
        .catch((e: Error) => { useTranslate.setState({ claudeError: e.message }); throw e; });
      useTranslate.setState({ claudeError: '' });
      putLine(this.gameId, lang, lb.source, r.translation, 'claude');
      if (r.source) this.learn(box, r.source);
      return { state: 'done', translation: r.translation, by: 'claude' };
    }
    return { state: 'raw' };
  }

  /** Characters Claude corrected, seen twice the same way, become this game's own readings. */
  private learn(box: Box, corrected: string) {
    const ok = confirm(this.guesses, corrections(box.glyphs, corrected)).filter(([k]) => !(k in this.learned));
    if (!ok.length) return;
    this.learned = { ...this.learned, ...Object.fromEntries(ok) };
    putGlyphs(this.gameId, this.learned);
    this.send({ type: 'learned', map: this.learned });
  }
}
