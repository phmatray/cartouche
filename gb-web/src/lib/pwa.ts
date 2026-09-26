/** Offline app shell, updates, and "Install as an app" (the browser's prompt, or the Share sheet on iPhone and iPad). */
interface InstallPrompt extends Event { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> }

let deferred: InstallPrompt | null = null;
const UPDATED = 'cartouche-updated';

export function setupPwa(onUpdated: () => void) {
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e as InstallPrompt; });
  window.addEventListener('appinstalled', () => { deferred = null; });
  // A Home Screen app asks to keep its storage (Safari grants it to installed apps; elsewhere it's a request).
  if (isInstalled()) navigator.storage?.persist?.().catch(() => {});
  try { if (sessionStorage.getItem(UPDATED)) { sessionStorage.removeItem(UPDATED); onUpdated(); } } catch { /* storage blocked */ }
  // Production only: in dev the service worker would cache Vite's live modules.
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', async () => {
    const reg = await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL }).catch(() => null);
    // A version downloaded during an earlier session waits for this launch: it takes over now, before anything is
    // played, and the page reloads once so the app and its cache are the same version.
    if (reg?.waiting && navigator.serviceWorker.controller) {
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        try { sessionStorage.setItem(UPDATED, '1'); } catch { /* storage blocked */ }
        location.reload();
      }, { once: true });
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

export const device = () => (/iPhone|iPod/.test(navigator.userAgent) ? 'iPhone' : 'iPad');

/** Shows the browser's install prompt. false when the browser offers none (then it's in its menu, or already installed). */
export async function promptInstall(): Promise<boolean> {
  if (!deferred) return false;
  const d = deferred;
  deferred = null;
  await d.prompt();
  return (await d.userChoice).outcome === 'accepted';
}
