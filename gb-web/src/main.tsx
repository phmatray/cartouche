import { createRoot } from 'react-dom/client'
import '@fontsource-variable/archivo/wdth.css'
import './index.css'
import { ready, t } from './i18n'
import App from './App'
import { setupPwa } from './lib/pwa'
import { toast } from './components/shell/actions'

// The service worker can answer before the language chunk has loaded: toast in the user's language, once it has.
setupPwa(() => { ready.then(() => toast(t('shell.updated'), 'c')) })

// Note: StrictMode is disabled because it double-invokes callbacks,
// which conflicts with wasm-bindgen's &mut self borrow checking.
ready.then(() => createRoot(document.getElementById('root')!).render(<App />))
