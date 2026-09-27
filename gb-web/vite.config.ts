import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import wasm from 'vite-plugin-wasm'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import { execFileSync } from 'child_process'

// GitHub Pages serves 404.html for unknown paths; a copy of index.html lets the SPA router take over.
// The service worker gets the list of built files to keep offline (not og.png, only for link previews), and a version that changes with them.
const spaFallback = (): Plugin => ({
  name: 'spa-404-fallback-and-sw',
  apply: 'build',
  closeBundle() {
    const out = path.resolve(import.meta.dirname, 'dist')
    fs.copyFileSync(path.join(out, 'index.html'), path.join(out, '404.html'))
    const files = (fs.readdirSync(out, { recursive: true }) as string[])
      .map((f) => f.split(path.sep).join('/'))
      // splash/ and app-screens/ (manifest screenshots) are read once, when the app is installed: not worth keeping offline.
      // roms/gbstudio/*.gb(c) (the GB Studio collection's hosted ROMs, several MB) is fetched only when the player downloads a game;
      // its LICENSES.txt stays, since the downloaded games play offline.
      .filter((f) => fs.statSync(path.join(out, f)).isFile() && !/^(404\.html|sw\.js|og\.png|splash\/.*|app-screens\/.*|roms\/gbstudio\/.*\.gbc?)$/.test(f) && !f.endsWith('.map'))
      .sort()
    const hash = crypto.createHash('sha1')
    for (const f of files) hash.update(f).update(fs.readFileSync(path.join(out, f)))
    const sw = path.join(out, 'sw.js')
    fs.writeFileSync(sw, fs.readFileSync(sw, 'utf8')
      .replace("const VERSION = 'dev';", `const VERSION = '${hash.digest('hex').slice(0, 12)}';`)
      .replace('[/*__FILES__*/]', JSON.stringify(['./', ...files])))
  },
})

// Every published build (Pages and the release zip) carries the license texts it must:
// LICENSE.txt (Cartouche), THIRD_PARTY_NOTICES.txt (bundled ROMs, GameDataBase, fonts...) and
// THIRD_PARTY_LICENSES.txt with the full license of each npm package in the bundle and each Rust
// crate compiled into the WebAssembly core.
const LICENSE_FILE = /^(licen[cs]e|copying|notice)/i
const licenseTexts = (dir: string) =>
  fs.readdirSync(dir).filter((f) => LICENSE_FILE.test(f)).sort()
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8').trim())

function npmLicenses(moduleIds: Iterable<string>): string[] {
  const dirs = new Set<string>()
  for (const id of moduleIds) {
    const m = /^(.*[\\/]node_modules[\\/](?:@[^\\/]+[\\/])?[^\\/]+)[\\/]/.exec(id.replace(/^\0/, ''))
    if (m) dirs.add(m[1])
    // Vite's (module preload) and Rolldown's (CommonJS interop) runtime helpers are virtual modules.
    else if (id.startsWith('\0vite/')) dirs.add(path.resolve(import.meta.dirname, 'node_modules/vite'))
    else if (id.startsWith('\0rolldown/')) dirs.add(path.resolve(import.meta.dirname, 'node_modules/rolldown'))
  }
  return [...dirs].sort().map((dir) => {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
    const texts = licenseTexts(dir)
    if (!texts.length) throw new Error(`No license file in ${dir}`)
    return `${pkg.name} ${pkg.version} (npm, ${pkg.license})\n\n${texts.join('\n\n')}`
  })
}

// Crates linked into the wasm binary: normal dependencies of gb-core for wasm32, not proc-macros.
function crateLicenses(): string[] {
  const meta = JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--locked',
    '--filter-platform', 'wasm32-unknown-unknown', '--manifest-path', path.resolve(import.meta.dirname, '../gb-core/Cargo.toml')],
  { encoding: 'utf8', maxBuffer: 64 << 20 }))
  type Pkg = { id: string; name: string; version: string; license: string; manifest_path: string; targets: { kind: string[] }[] }
  type Node = { id: string; deps: { pkg: string; dep_kinds: { kind: string | null }[] }[] }
  const pkgs = new Map<string, Pkg>(meta.packages.map((p: Pkg) => [p.id, p]))
  const nodes = new Map<string, Node>(meta.resolve.nodes.map((n: Node) => [n.id, n]))
  const seen = new Set<string>()
  const walk = (id: string) => {
    for (const d of nodes.get(id)!.deps) {
      const p = pkgs.get(d.pkg)!
      if (seen.has(d.pkg) || !d.dep_kinds.some((k) => k.kind === null)) continue
      if (p.targets.some((t) => t.kind.includes('proc-macro'))) continue
      seen.add(d.pkg)
      walk(d.pkg)
    }
  }
  walk(meta.resolve.root)
  return [...seen].map((id) => pkgs.get(id)!).sort((a, b) => a.name.localeCompare(b.name)).map((p) => {
    const texts = licenseTexts(path.dirname(p.manifest_path))
    if (!texts.length) throw new Error(`No license file for crate ${p.name}`)
    return `${p.name} ${p.version} (Rust crate, ${p.license})\n\n${texts.join('\n\n')}`
  })
}

const licenseFiles = (): Plugin => ({
  name: 'license-files',
  apply: 'build',
  generateBundle(_options, bundle) {
    const ids = Object.values(bundle).flatMap((c) => (c.type === 'chunk' ? c.moduleIds : []))
    const sep = `\n\n${'='.repeat(78)}\n\n`
    const emit = (fileName: string, source: string) => this.emitFile({ type: 'asset', fileName, source })
    emit('LICENSE.txt', fs.readFileSync(path.resolve(import.meta.dirname, '../LICENSE'), 'utf8'))
    emit('THIRD_PARTY_NOTICES.txt', fs.readFileSync(path.resolve(import.meta.dirname, '../THIRD_PARTY_NOTICES.md'), 'utf8'))
    emit('THIRD_PARTY_LICENSES.txt',
      'Licenses of the third-party code included in this build of Cartouche.\n' +
      'Other bundled works (the ROMs in roms/, GameDataBase data, fonts) are listed in THIRD_PARTY_NOTICES.txt.' +
      sep + [...npmLicenses(ids), ...crateLicenses()].join(sep) + '\n')
  },
})

// French and Spanish are their own chunks, imported once the app has run (i18n/core.ts): a first visit would wait one more
// round-trip before it renders. A tiny inline script picks the language as i18n/index.ts does and preloads its chunk at once.
const preloadLang = (): Plugin => {
  let base = '/'
  return {
    name: 'preload-lang',
    apply: 'build',
    configResolved(c) { base = c.base },
    transformIndexHtml: {
      order: 'post',
      handler(_html, { bundle }) {
        const urls: Record<string, string> = {}
        for (const c of Object.values(bundle ?? {})) {
          const m = c.type === 'chunk' && /[\\/]i18n[\\/](\w+)[\\/]index\.ts$/.exec(c.facadeModuleId ?? '')
          if (m && m[1] !== 'en') urls[m[1]] = base + c.fileName
        }
        if (!Object.keys(urls).length) throw new Error('preload-lang: no language chunk found')
        return [{
          tag: 'script',
          injectTo: 'head-prepend',
          children: `try{var u=${JSON.stringify(urls)},s=JSON.parse(localStorage.getItem('gb-settings')||'{}').state,l=s&&s.language;` +
            `if(!l)for(var x of navigator.languages||[navigator.language]){x=x.toLowerCase().split('-')[0];if(/^(en|fr|es)$/.test(x)){l=x;break}}` +
            `if(u[l]){var k=document.createElement('link');k.rel='modulepreload';k.crossOrigin='';k.href=u[l];document.head.appendChild(k)}}catch(e){}`,
        }]
      },
    },
  }
}

const ONLINE_ONLY = /\/node_modules\/(trystero|@trystero-p2p|@noble|uqr)\//

export default defineConfig(({ mode }) => ({
  // Deployed at https://phmatray.github.io/cartouche/ (build and preview); the dev server stays at '/'.
  base: mode === 'production' ? '/cartouche/' : '/',
  plugins: [react(), wasm(), tailwindcss(), licenseFiles(), preloadLang(), spaFallback()],
  worker: {
    format: 'es',
    plugins: () => [wasm()],
  },
  build: {
    rolldownOptions: {
      // Libraries change far less often than the app: their own chunk stays cached across releases.
      output: {
        codeSplitting: {
          // Online play's libraries (WebRTC rooms, QR codes) load with it, never with the library.
          groups: [
            { debugName: 'p2p', name: (id) => (ONLINE_ONLY.test(id) ? 'p2p' : null) },
            // Device sync's QR reader: loaded when the camera opens.
            { debugName: 'qr-scan', name: (id) => (/\/node_modules\/qr\//.test(id) ? 'qr-scan' : null) },
            { debugName: 'vendor', name: (id) => (id.includes('/node_modules/') && !id.endsWith('.css') ? 'vendor' : null) },
          ],
        },
      },
    },
  },
  resolve: {
    alias: {
      'gb-core': path.resolve(import.meta.dirname, '../gb-core/pkg'),
    },
  },
  server: {
    fs: {
      allow: ['..'],
    },
    watch: {
      ignored: ['!**/gb-core/pkg/**'],
    },
  },
}))
