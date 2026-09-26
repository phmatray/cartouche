// Rewind check: while R is held the picture must run backwards, and on release play resumes from the
// last rewound frame without a jump. Needs a running preview (cd gb-web && npm run build && npx vite preview).
// Usage: NODE_PATH=<dir with playwright> node scripts/check-rewind.mjs [http://localhost:4173/cartouche/] [game-id, default ucity]
import { createRequire } from 'module';

const { chromium } = createRequire(import.meta.url)('playwright'); // resolved through NODE_PATH

const base = process.argv[2] ?? 'http://localhost:4173/cartouche/';
const game = process.argv[3] ?? 'ucity'; // its title screen keeps scrolling the whole map: every rewind step shows
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage();
// Keep the WebGL drawing buffer readable after compositing, and expose a pixel grabber.
await page.addInitScript(() => {
  const get = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, opts) {
    return get.call(this, type, type.startsWith('webgl') ? { ...opts, preserveDrawingBuffer: true } : opts);
  };
  window.__grab = () => {
    const src = document.querySelector('canvas.lcd');
    const c = document.createElement('canvas');
    c.width = 160; c.height = 144;
    const ctx = c.getContext('2d');
    ctx.drawImage(src, 0, 0, 160, 144);
    return Array.from(ctx.getImageData(0, 0, 160, 144).data);
  };
});
await page.goto(`${base}game/${game}/play`);
await page.waitForSelector('canvas.lcd');
await wait(3000);
// Play a while so the rewind buffer fills; other games get keys to start moving (ucity's title leaves on any key).
const keys = game === 'ucity' ? [] : ['Enter', 'z', 'Enter', 'z', 'Enter', 'Enter', ...Array(12).fill('z')];
for (const k of keys) await page.keyboard.press(k).then(() => wait(500));
await wait(keys.length ? 0 : 5000);

const diff = (a, b) => { let n = 0; for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) n++; return n / (a.length / 4); };
const pct = (x) => `${(x * 100).toFixed(2)}%`;
const grab = () => page.evaluate(() => window.__grab());

// Normal inter-frame change, for reference.
const f0 = await grab();
const f1 = await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(window.__grab())))));
const playDiff = diff(f0, f1);

await page.keyboard.down('r');
const held = [];
for (let i = 0; i < 8; i++) { await wait(250); held.push(await grab()); }
// Release, then read the frame the app draws on the very next animation frame (1 emulated frame later).
const [lastHeld, afterRelease] = await page.evaluate(() => new Promise((resolve) => {
  const last = window.__grab();
  window.dispatchEvent(new KeyboardEvent('keyup', { key: 'r' }));
  requestAnimationFrame(() => requestAnimationFrame(() => resolve([last, window.__grab()])));
}));
await page.keyboard.up('r'); // Playwright's own key state; the app already saw the keyup

const steps = held.slice(1).map((h, i) => diff(held[i], h));
const changed = steps.filter((d) => d > 0).length;
const releaseDiff = diff(lastHeld, afterRelease);
console.log(`game ${game}`);
console.log(`play: change over 1-2 frames ${pct(playDiff)}`);
console.log(`hold R: ${held.length} samples 250 ms apart, ${changed}/${steps.length} consecutive pairs differ; changed pixels ${steps.map(pct).join(' ')}`);
console.log(`release: last held frame vs next frame drawn ${pct(releaseDiff)}`);
await browser.close();

const ok = changed >= steps.length - 1 && releaseDiff <= Math.max(0.05, playDiff * 2);
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
