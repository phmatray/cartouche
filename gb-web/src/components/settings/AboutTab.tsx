import { Link } from 'react-router';
import { isInstalled, promptInstall } from '../../lib/pwa';
import { toast } from '../shell/actions';
import { ShortcutsList } from '../shell/Shortcuts';
import { I, REPO_URL } from '../icons';
import { Row } from './parts';

export function AboutTab() {
  const installed = isInstalled();
  const install = async () => {
    if (!(await promptInstall())) toast('Look for “Install” in your browser’s address bar or menu', 'c');
  };
  return (
    <>
      <h2>About</h2>
      <p className="intro">Cartouche is a Game Boy and Game Boy Color emulator that runs entirely in your browser. The core is written in Rust and compiled to WebAssembly.</p>

      <Row label="Source code" sub="Open source under the MIT License. Issues and contributions welcome.">
        <a className="btn line" style={{ color: 'var(--ink)' }} href={REPO_URL} target="_blank" rel="noopener">{I.github}Cartouche on GitHub</a>
      </Row>

      <h3>Your data</h3>
      <p className="intro" style={{ margin: '8px 0 0' }}>
        No account, no server, no tracking, no analytics. ROMs, saves, screenshots and settings are stored in this browser (IndexedDB and local storage) and never uploaded.
        The only requests to other sites are for box art of recognized ROMs you added, from the libretro-thumbnails project on GitHub (raw.githubusercontent.com),
        and only if you agree to it (it’s off by default; change it in <Link to="/settings/storage" style={{ color: 'var(--ink)' }}>Storage</Link>). Cartouche never offers commercial ROMs: bring your own dumps.
      </p>

      <h3>Install</h3>
      <Row label="Install as an app" sub={installed ? 'Installed: you’re using the app window.' : 'Opens in its own window and works offline after the first visit'}>
        <button className="btn k" disabled={installed} onClick={install}>{installed ? 'Installed' : 'Install'}</button>
      </Row>

      <h3>Keyboard shortcuts</h3>
      <ShortcutsList />

      <h3>Credits</h3>
      <p className="intro" style={{ margin: '8px 0 0' }}>
        Optional box art from the libretro-thumbnails project. Game details from GameDataBase © 2024 by PigSaint (<a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer" style={{ color: 'var(--ink)' }}>CC BY 4.0</a>), modified, and No-Intro names from libretro-database (<a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noreferrer" style={{ color: 'var(--ink)' }}>CC BY-SA 4.0</a>).
        Typeface: Archivo, © 2020 The Archivo Project Authors (<a href={`${import.meta.env.BASE_URL}licenses/OFL-Archivo.txt`} target="_blank" rel="noreferrer" style={{ color: 'var(--ink)' }}>SIL Open Font License 1.1</a>), served from this site. Bundled games: <Link to="/game/tobu-tobu-girl" style={{ color: 'var(--ink)' }}>Tobu Tobu Girl</Link> and <Link to="/game/tobu-tobu-girl-deluxe" style={{ color: 'var(--ink)' }}>Tobu Tobu Girl Deluxe</Link> © 2017 Tangram Games (code MIT, assets <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer" style={{ color: 'var(--ink)' }}>CC BY 4.0</a>);
        {' '}<Link to="/game/ucity" style={{ color: 'var(--ink)' }}>µCity</Link> © 2017-2018 Antonio Niño Díaz (<a href={`${import.meta.env.BASE_URL}licenses/GPL-3.0-ucity.txt`} target="_blank" rel="noreferrer" style={{ color: 'var(--ink)' }}>GPL-3.0-or-later</a>; graphics and music <a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noreferrer" style={{ color: 'var(--ink)' }}>CC BY-SA 4.0</a>; <a href="https://github.com/AntonioND/ucity/tree/v1.3" target="_blank" rel="noreferrer" style={{ color: 'var(--ink)' }}>source</a>).
        Test cartridges: dmg-acid2 and cgb-acid2 © 2020 Matt Currie (MIT); cpu_instrs by Shay Green (Blargg), no license stated, will be removed on the author’s request. Each is credited on its game page.
        Open-source licenses: <a href={import.meta.env.BASE_URL + 'THIRD_PARTY_NOTICES.txt'} style={{ color: 'var(--ink)' }}>third-party notices</a> and <a href={import.meta.env.BASE_URL + 'THIRD_PARTY_LICENSES.txt'} style={{ color: 'var(--ink)' }}>full license texts</a>.
        Game Boy and Game Boy Color are trademarks of Nintendo; Cartouche is not affiliated with Nintendo. See <Link to="/legal" style={{ color: 'var(--ink)' }}>Legal</Link>.
      </p>
    </>
  );
}
