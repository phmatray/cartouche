import { useEffect, useId, useRef, useState } from 'react';
import { consoleOf, useSettingsStore } from '../../store/settingsStore';
import { STARTUP, type Startup } from '../../lib/settings-clean';
import { pacer } from '../../lib/pace';
import { Row, Seg, SwitchRow } from './parts';
import { I } from '../icons';
import { useT } from '../../i18n';
import { reducedMotion } from '../../lib/ui';

/** What the previews switch on: a cartridge that is only a header (title CARTOUCHE, a loop at $0100). */
const PREVIEW_ROM = (() => {
  const r = new Uint8Array(0x8000);
  r.set([0x00, 0x18, 0xfe], 0x100); // NOP; JR -2
  r.set([...'CARTOUCHE'].map((c) => c.charCodeAt(0)), 0x134);
  let sum = 0;
  for (let i = 0x134; i <= 0x14c; i++) sum = (sum - r[i] - 1) & 0xff;
  r[0x14d] = sum;
  return r;
})();
/** Frames run before the still is taken: the animation's steady picture (its frame ~140 of 160). */
const STILL_AT = 142;
/** Steady pictures, made once per session (by animation and colour): 142 frames each is too long to redo on every visit. */
const stills = new Map<string, Uint8Array>();
/** Frames run per animation frame while a still is made, so the page never stalls on it. */
const STILL_STEP = 24;

let core: Promise<{ wasm: typeof import('gb-core'); memory: WebAssembly.Memory }> | null = null;
const loadCore = () => (core ??= import('gb-core').then(async (wasm) => ({ wasm, memory: (await wasm.default()).memory })));

/** The previews' sound, played as it is made, a little ahead of the audio clock. */
let audio: { ctx: AudioContext; out: GainNode; at: number } | null = null;
function playSamples(samples: Float32Array, volume: number) {
  if (!audio) {
    const ctx = new AudioContext({ sampleRate: 44100 });
    const out = ctx.createGain();
    out.connect(ctx.destination);
    audio = { ctx, out, at: 0 };
  }
  const { ctx, out } = audio;
  if (ctx.state !== 'running') void ctx.resume();
  out.gain.value = volume;
  const n = samples.length >> 1;
  if (!n) return;
  const buf = ctx.createBuffer(2, n, 44100);
  const l = buf.getChannelData(0), r = buf.getChannelData(1);
  for (let i = 0; i < n; i++) { l[i] = samples[2 * i]; r[i] = samples[2 * i + 1]; }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(out);
  audio.at = Math.max(audio.at, ctx.currentTime + 0.05);
  src.start(audio.at);
  audio.at += n / 44100;
}
/** Lets the audio device go once the queued sound has played (a running one keeps iOS rendering silence). */
function releaseAudio(close = false) {
  const a = audio;
  if (!a) return;
  if (close) { audio = null; void a.ctx.close(); return; }
  setTimeout(() => { if (a.ctx.state === 'running' && a.at <= a.ctx.currentTime) void a.ctx.suspend(); }, Math.max(0, a.at - a.ctx.currentTime) * 1000 + 100);
}

/**
 * One start-up animation, played by the real core and boot ROM on its own small screen: its steady picture while
 * idle, the whole animation each time `play` goes up. Silent unless `sound`.
 */
function StartupPreview({ animation, color, play, sound }: { animation: number; color: boolean; play: number; sound: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const soundRef = useRef(sound);
  useEffect(() => { soundRef.current = sound; }, [sound]);
  useEffect(() => {
    const ctx = ref.current?.getContext('2d');
    if (!ctx) return;
    const img = ctx.createImageData(160, 144);
    let raf = 0, stopped = false;
    let emu: import('gb-core').Emulator | null = null;
    if (animation === 0) { // off: the game's own first picture, a blank screen (the core's lightest DMG shade)
      for (let i = 0; i < img.data.length; i += 4) img.data.set(color ? [255, 255, 255, 255] : [0xe0, 0xf8, 0xd0, 255], i);
      ctx.putImageData(img, 0, 0);
      return;
    }
    const key = `${animation}:${color}`;
    const show = (px: Uint8Array) => { img.data.set(px); ctx.putImageData(img, 0, 0); };
    const cached = stills.get(key);
    if (cached) show(cached);
    loadCore().then(({ wasm, memory }) => {
      if (stopped) return;
      const e = new wasm.Emulator();
      emu = e;
      if (!e.load_rom_with(PREVIEW_ROM, color, 0, animation)) return;
      if (!play) {
        if (cached) return;
        // Not played: the steady picture, made a few frames at a time.
        let i = 0;
        const make = () => {
          if (stopped) return;
          for (const end = Math.min(STILL_AT, i + STILL_STEP); i < end; i++) { e.run_frame(); e.clear_audio_buffer(); }
          if (i < STILL_AT) { raf = requestAnimationFrame(make); return; }
          const still = e.framebuffer_snapshot();
          stills.set(key, still);
          show(still);
        };
        make();
        return;
      }
      const due = pacer();
      let frames = 0;
      const tick = (now: number) => {
        if (stopped) return;
        for (let n = due(now); n > 0; n--) {
          e.run_frame();
          frames++;
          if (frames === STILL_AT && !stills.has(key)) stills.set(key, e.framebuffer_snapshot());
          const len = e.audio_buffer_len(), ptr = e.audio_buffer_ptr();
          if (soundRef.current && len && ptr) playSamples(new Float32Array(memory.buffer, ptr, len), useSettingsStore.getState().masterVolume / 100);
          e.clear_audio_buffer();
        }
        // Played to its end (the boot ROM hands over to the cartridge): back to the steady picture.
        const done = !e.booting() || frames > 400;
        show(done ? stills.get(key) ?? e.framebuffer_snapshot() : e.framebuffer_snapshot());
        if (done) releaseAudio(); else raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }).catch(() => { /* no WASM: the preview stays dark */ });
    return () => { stopped = true; cancelAnimationFrame(raf); emu?.free(); };
  }, [animation, color, play]);
  return <canvas ref={ref} className="lcd" width={160} height={144} aria-hidden="true" />;
}

/** The start-up animation: one card per choice, each previewed live, with replay and sound. */
function StartupRows() {
  const value = useSettingsStore((s) => s.startupAnimation);
  const set = useSettingsStore((s) => s.set);
  const color = useSettingsStore((s) => consoleOf(s.console) !== 'dmg');
  const t = useT();
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const [plays, setPlays] = useState([0, 0, 0, 0]);
  const [sound, setSound] = useState(false);
  const replay = (i: number) => setPlays((p) => p.map((n, k) => (k === i ? n + 1 : n)));
  const choose = (a: Startup) => { set({ startupAnimation: a }); replay(STARTUP.indexOf(a)); };
  // Each plays once when the choices first come into view (not with reduced motion: the steady pictures stay).
  useEffect(() => {
    const el = box.current;
    if (!el || reducedMotion()) return;
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return;
      io.disconnect();
      setPlays((p) => p.map((n) => n + 1));
    }, { threshold: 0.4 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(() => () => releaseAudio(true), []);
  const selected = Math.max(0, STARTUP.indexOf(value));
  return (
    <div className="row col">
      <span>{t('settings.emu.startup')}<small id={id}>{t('settings.emu.startupSub')}</small></span>
      <div ref={box} className="presets presets-4" role="group" aria-label={t('settings.emu.startup')} aria-describedby={id}>
        {STARTUP.map((a, i) => (
          <button key={a} className="preset" aria-pressed={value === a} onClick={() => choose(a)}>
            <StartupPreview animation={i} color={color} play={plays[i]} sound={sound} />
            <b>{t(`settings.emu.anims.${a}.label`)}</b><small>{t(`settings.emu.anims.${a}.description`)}</small>
          </button>
        ))}
      </div>
      <div className="boot-acts">
        <button className="sbtn" disabled={selected === 0} onClick={() => replay(selected)}>{I.play}{t('settings.emu.replay')}</button>
        <button className="sbtn" aria-pressed={sound} disabled={selected === 0} onClick={() => { if (!sound && selected) replay(selected); setSound(!sound); }}>
          {sound ? I.mute : I.sound}{sound ? t('settings.emu.mute') : t('settings.emu.withSound')}
        </button>
      </div>
    </div>
  );
}

export function EmulationTab() {
  const s = useSettingsStore();
  const t = useT();
  return (
    <>
      <h2>{t('settings.tabs.emulation')}</h2>
      <p className="intro">{t('settings.emu.intro')}</p>
      <Row label={t('settings.emu.speed')} sub={t('settings.emu.speedSub')}>
        <Seg<number> label={t('settings.emu.speed')} value={s.defaultSpeed} options={[[0.5, '½×'], [1, '1×'], [2, '2×'], [4, '4×']]} set={s.setDefaultSpeed} />
      </Row>
      <Row label={t('settings.emu.rewind')} sub={t('settings.emu.rewindSub')}>
        <span className="range">
          <input type="range" min={5} max={60} step={5} value={s.rewindBufferSeconds} aria-label={t('settings.emu.rewind')} aria-valuetext={`${s.rewindBufferSeconds} s`} onChange={(e) => s.setRewindBufferSeconds(+e.target.value)} />
          <span className="v" aria-hidden="true">{s.rewindBufferSeconds} s</span>
        </span>
      </Row>
      <StartupRows />
      <h3>{t('settings.emu.progress')}</h3>
      <SwitchRow label={t('settings.emu.resume')} sub={t('settings.emu.resumeSub')} on={s.resumePoints} set={(v) => s.set({ resumePoints: v })} />
      <SwitchRow label={t('settings.emu.auto')} sub={t('settings.emu.autoSub')} on={s.autoSaveEnabled} set={s.setAutoSaveEnabled} />
      <Row label={t('settings.emu.every')}>
        <label className="sel">
          <select value={s.autoSaveIntervalSeconds} disabled={!s.autoSaveEnabled} aria-label={t('settings.emu.every')} onChange={(e) => s.setAutoSaveIntervalSeconds(+e.target.value)}>
            <option value={30}>{t('settings.emu.s30')}</option><option value={60}>{t('settings.emu.m1')}</option><option value={300}>{t('settings.emu.m5')}</option>
          </select>
        </label>
      </Row>
    </>
  );
}
