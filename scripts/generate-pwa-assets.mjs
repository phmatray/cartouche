// Draws the home-screen icons and the iPhone launch screens (committed under gb-web/public/).
// Run again only when the mark or the device list changes:
//   (cd gb-web && npm ci) && NODE_PATH=<a node_modules with playwright> node scripts/generate-pwa-assets.mjs
// Prints the <link rel="apple-touch-startup-image"> tags to paste into gb-web/index.html.
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const { chromium } = createRequire(import.meta.url)('playwright'); // not a project dependency: resolved through NODE_PATH
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pub = path.join(root, 'gb-web/public');
const font = fs.readFileSync(path.join(root, 'gb-web/node_modules/@fontsource-variable/archivo/files/archivo-latin-wdth-normal.woff2')).toString('base64');

// The CMY strip on the black band. w: bar width, g: gap, h: height, in a 512 box.
const mark = (w, g, h) => {
  const x = 256 - (3 * w + 2 * g) / 2, y = 256 - h / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="#141414"/>${
    ['#009FE3', '#E5007E', '#FFD400'].map((c, i) => `<rect x="${x + i * (w + g)}" y="${y}" width="${w}" height="${h}" fill="${c}"/>`).join('')}</svg>`;
};
// "any": shown as is, so the mark fills more of the tile. "maskable": the mark stays inside the
// 40% safe circle (corners at ~167 px from the centre, < 204.8) whatever shape the launcher cuts.
const ANY = mark(80, 18, 320);
const MASKABLE = mark(64, 20, 240);
const ICONS = [
  ['icon-192.png', ANY, 192], ['icon-512.png', ANY, 512],
  ['icon-maskable-192.png', MASKABLE, 192], ['icon-maskable-512.png', MASKABLE, 512],
  // iOS rounds the corners itself and wants no transparency.
  ['apple-touch-icon.png', ANY, 180], ['apple-touch-icon-167.png', ANY, 167], ['apple-touch-icon-152.png', ANY, 152],
];

// Portrait iPhones, CSS points and pixel ratio (landscape launches fall back to the black background).
const PHONES = [
  [440, 956, 3], // 16 Pro Max, 17 Pro Max
  [420, 912, 3], // Air
  [402, 874, 3], // 16 Pro, 17, 17 Pro
  [430, 932, 3], // 14 Pro Max, 15 Plus, 15 Pro Max, 16 Plus
  [428, 926, 3], // 12 Pro Max, 13 Pro Max, 14 Plus
  [393, 852, 3], // 14 Pro, 15, 15 Pro, 16
  [390, 844, 3], // 12, 13, 14, 16e
  [375, 812, 3], // X, XS, 11 Pro, 12 mini, 13 mini
  [414, 896, 3], // XS Max, 11 Pro Max
  [414, 896, 2], // XR, 11
  [414, 736, 3], // 6s Plus, 7 Plus, 8 Plus
  [375, 667, 2], // SE, 8
];
const SPLASH = `<!doctype html><style>
@font-face{font-family:A;src:url(data:font/woff2;base64,${font}) format('woff2');font-stretch:62% 125%;font-weight:100 900}
html,body{margin:0;height:100%;background:#141414}
body{display:flex;align-items:center;justify-content:center;gap:18px}
.s{display:grid;grid-template-columns:repeat(3,16px);gap:4px}.s i{height:52px}
.s i:nth-child(1){background:#009FE3}.s i:nth-child(2){background:#E5007E}.s i:nth-child(3){background:#FFD400}
b{font:900 52px/1 A;font-stretch:62%;text-transform:uppercase;letter-spacing:.01em;color:#F4F4F0}
</style><span class="s"><i></i><i></i><i></i></span><b>Cartouche</b>`;

const browser = await chromium.launch().catch(() => chromium.launch({ channel: 'chrome' })); // the installed Chrome if Playwright has no browser
for (const [file, svg, size] of ICONS) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<style>html,body{margin:0}</style><img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" width="${size}" height="${size}" style="display:block">`);
  await page.screenshot({ path: path.join(pub, file) });
  await page.close();
}
fs.mkdirSync(path.join(pub, 'splash'), { recursive: true });
const links = [];
for (const [w, h, dpr] of PHONES) {
  const file = `splash/iphone-${w * dpr}x${h * dpr}.png`;
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: dpr });
  await page.setContent(SPLASH);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(pub, file) });
  await page.close();
  links.push(`<link rel="apple-touch-startup-image" href="/${file}" media="(device-width: ${w}px) and (device-height: ${h}px) and (-webkit-device-pixel-ratio: ${dpr}) and (orientation: portrait)" />`);
}
await browser.close();
console.log(links.join('\n'));
