import { createRoot } from 'react-dom/client'
import '@fontsource-variable/archivo/wdth.css'
import './index.css'
import { ready, t } from './i18n'
import App from './App'
import { setupPwa } from './lib/pwa'
import { toast } from './components/shell/actions'

setupPwa(() => toast(t('shell.updated'), 'c'))

// Note: StrictMode is disabled because it double-invokes callbacks,
// which conflicts with wasm-bindgen's &mut self borrow checking.
ready.then(() => createRoot(document.getElementById('root')!).render(<App />))
