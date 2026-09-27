/** Offline app shell, updates, and "Install as an app" (the browser's prompt, or the Share sheet on iPhone and iPad). */
import { create } from 'zustand';

interface InstallPrompt extends Event { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> }

let deferred: InstallPrompt | null = null;
const VERSION_KEY = 'cartouche-version';

/**
 * How this browser can install the app right now, for the menus: 'prompt' (its own install dialog),
 * 'ios' (Share › Add to Home Screen, in Safari), or null (installed, or no way offered).
 */
export const useInstall = create<{ can: 'prompt' | 'ios' | null }>(() => ({ can: null }));
const refresh = () => useInstall.setState({ can: isInstalled() ? null : deferred ? 'prompt' : isIos() ? 'ios' : null });

export function setupPwa(onUpdated: () => void) {
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e as InstallPrompt; refresh(); });
  window.addEventListener('appinstalled', () => { deferred = null; useInstall.setState({ can: null }); });
  matchMedia('(display-mode: standalone)').addEventListener?.('change', refresh);
  refresh();
  // A Home Screen app asks to keep its storage (Safari grants it to installed apps; elsewhere it's a request).
  if (isInstalled()) navigator.storage?.persist?.().catch(() => {});
  // Production only: in dev the service worker would cache Vite's live modules.
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  // "Updated": the version running this page differs from the last one seen. This covers both ways a new version
  // lands: the reload below, and a relaunch after the waiting worker activated on its own when the app closed.
  navigator.serviceWorker.addEventListener('message', (e) => {
    const version = (e.data as { version?: string } | null)?.version;
    if (!version) return;
    try {
      const seen = localStorage.getItem(VERSION_KEY);
      localStorage.setItem(VERSION_KEY, version);
      if (seen && seen !== version) onUpdated();
    } catch { /* storage blocked */ }
  });
  navigator.serviceWorker.controller?.postMessage('version');
  window.addEventListener('load', async () => {
    const reg = await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL }).catch(() => null);
    // A version downloaded during an earlier session waits for this launch: it takes over now, before anything is
    // played, and the page reloads once so the app and its cache are the same version. Not while another tab or
    // window of the app is open (the worker declines): that one would lose its version's lazy chunks.
    if (reg?.waiting && navigator.serviceWorker.controller) {
      navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
      reg.waiting.postMessage('activate');
    }
    // Installed apps are resumed more than relaunched: look for a new version when coming back.
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg?.update().catch(() => {}); });
  });
}

/** Running as an installed app (Home Screen on iOS, an app window elsewhere). */
export const isInstalled = () =>
  matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

/** iPhone or iPad (iPadOS reports itself as a Mac with touch). No install prompt there: Share › Add to Home Screen. */
export const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/** Safari itself: other iOS browsers put Share elsewhere, and in-app browsers can't add to the Home Screen at all. */
export const isIosSafari = () =>
  isIos() && /Safari\//.test(navigator.userAgent) && !/CriOS|FxiOS|EdgiOS|OPiOS|FBAN|FBAV|Instagram|Line\/|GSA\//.test(navigator.userAgent);

/**
 * `accept` for a file input. iOS has no file type for .gb/.gbc/.sav/.cartouche, so a filter by
 * extension greys those files out in the picker: there, accept anything and let the import check it.
 */
export const fileAccept = (extensions: string) => (isIos() ? undefined : extensions);

/** Chrome, Edge or Firefox on iOS 16.4 or later: they add to the Home Screen from their own Share menu. */
export const isIosBrowser = () => {
  const v = /OS (\d+)_(\d+)/.exec(navigator.userAgent);
  return isIos() && /CriOS|FxiOS|EdgiOS/.test(navigator.userAgent) && !!v && +v[1] * 100 + +v[2] >= 1604;
};

export const device = () => (/iPhone|iPod/.test(navigator.userAgent) ? 'iPhone' : 'iPad');

/** Shows the browser's install prompt. false when the browser offers none (then it's in its menu, or already installed). */
export async function promptInstall(): Promise<boolean> {
  if (!deferred) return false;
  const d = deferred;
  deferred = null;
  refresh();
  await d.prompt();
  return (await d.userChoice).outcome === 'accepted';
}
