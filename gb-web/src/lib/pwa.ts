/** Offline app shell and "Install as an app". */
interface InstallPrompt extends Event { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> }

let deferred: InstallPrompt | null = null;

export function setupPwa() {
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e as InstallPrompt; });
  window.addEventListener('appinstalled', () => { deferred = null; });
  // Production only: in dev the service worker would cache Vite's live modules.
  if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL }).catch(() => {});
    });
  }
}

export const isInstalled = () => matchMedia('(display-mode: standalone)').matches;

/** Shows the browser's install prompt. false when the browser offers none (then it's in its menu, or already installed). */
export async function promptInstall(): Promise<boolean> {
  if (!deferred) return false;
  const d = deferred;
  deferred = null;
  await d.prompt();
  return (await d.userChoice).outcome === 'accepted';
}
