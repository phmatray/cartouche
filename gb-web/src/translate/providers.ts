/**
 * Who translates: Chrome's built-in Translator API (on-device, free, desktop Chrome 138+ only), or Claude
 * with the player's own Anthropic API key, called straight from the browser.
 */
import type { ChromeStatus, Lang } from './store';

// ---- Chrome's Translator API (https://developer.chrome.com/docs/ai/translator-api)

interface ChromeTranslator { translate(text: string): Promise<string> }
interface TranslatorStatic {
  availability(o: { sourceLanguage: string; targetLanguage: string }): Promise<'unavailable' | 'downloadable' | 'downloading' | 'available'>;
  create(o: { sourceLanguage: string; targetLanguage: string; monitor?: (m: EventTarget) => void }): Promise<ChromeTranslator>;
}
const api = () => (globalThis as unknown as { Translator?: TranslatorStatic }).Translator;

export async function chromeStatus(src: string, dst: Lang): Promise<ChromeStatus> {
  const T = api();
  if (!T) return 'missing';
  try { return await T.availability({ sourceLanguage: src, targetLanguage: dst }); } catch { return 'unavailable'; }
}

const translators = new Map<string, Promise<ChromeTranslator>>();
/**
 * The translator for a language pair, created once. A model that still has to be downloaded needs a user
 * gesture to start: call this from a click first (the toggle does), later calls reuse it.
 */
export function chromeTranslator(src: string, dst: Lang, onProgress?: (loaded: number) => void): Promise<ChromeTranslator> {
  const T = api();
  if (!T) return Promise.reject(new Error('This browser has no built-in translator'));
  const k = `${src}>${dst}`;
  let t = translators.get(k);
  if (!t) {
    t = T.create({
      sourceLanguage: src, targetLanguage: dst,
      monitor: (m) => m.addEventListener('downloadprogress', (e) => onProgress?.((e as ProgressEvent).loaded)),
    });
    t.catch(() => translators.delete(k));
    translators.set(k, t);
  }
  return t;
}

// ---- Claude (Anthropic Messages API, the player's own key)

export const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';
const LANG_NAME: Record<string, string> = { en: 'English', fr: 'French', es: 'Spanish', ja: 'Japanese' };

export interface ClaudeResult { translation: string; /** The original as Claude reads it, misread characters fixed. */ source?: string }

/**
 * One line, translated with the game's title and the lines before it (names and tone stay consistent).
 * The text comes from tile matching: Claude is told it may hold look-alike mistakes and □ for unread
 * characters, and returns the corrected original too (the reader learns from it).
 * ponytail: plain fetch, one request shape; the Anthropic SDK would add ~100 KB for nothing here.
 */
export async function claudeTranslate(o: { key: string; text: string; src: 'ja' | 'en'; dst: Lang; title: string; previous: string[]; signal?: AbortSignal }): Promise<ClaudeResult> {
  const system =
    `You translate the on-screen text of a ${LANG_NAME[o.src]} Game Boy game into ${LANG_NAME[o.dst]}. ` +
    'The text was read from the screen by matching 8x8 tiles against a font, so a few characters may be wrong ' +
    '(look-alike kana such as の/め, は/け, ま/え, さ/せ) and □ marks a character that could not be read: ' +
    'infer the intended words from context. Keep the translation short and natural, like game dialogue, ' +
    'and keep names consistent with the previous lines. Reply with JSON only: ' +
    '{"source": "<the original text, corrected>", "translation": "<the translation>"}';
  const prev = o.previous.length ? `Previous lines:\n${o.previous.map((l) => `- ${l}`).join('\n')}\n\n` : '';
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal: o.signal,
    headers: {
      'content-type': 'application/json',
      'x-api-key': o.key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL, max_tokens: 600, system,
      messages: [{ role: 'user', content: `Game: ${o.title}\n\n${prev}Text:\n${o.text}` }],
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { error?: { message?: string } } | null;
    throw new Error(res.status === 401 ? 'The API key was refused' : res.status === 429 ? 'Too many requests, or no credit left' : body?.error?.message || `Error ${res.status}`);
  }
  const data = await res.json() as { content?: { type: string; text?: string }[]; stop_reason?: string };
  if (data.stop_reason === 'refusal') throw new Error('Claude declined this line');
  const text = (data.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  return parseResult(text);
}

/** The JSON reply, tolerating a code fence or prose around it; plain text becomes the translation. */
export function parseResult(text: string): ClaudeResult {
  const m = /\{[\s\S]*\}/.exec(text);
  if (m) {
    try {
      const j = JSON.parse(m[0]) as Partial<ClaudeResult>;
      if (typeof j.translation === 'string') return { translation: j.translation.trim(), source: typeof j.source === 'string' ? j.source.trim() : undefined };
    } catch { /* not JSON after all */ }
  }
  return { translation: text };
}
