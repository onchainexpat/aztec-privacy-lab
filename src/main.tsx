import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
// Side-effect import — installs the console-intercept patches before any
// other module (including @aztec/wallets/embedded → pino-browser) can run.
// Pino-browser snapshots the global console at module load; if our patch
// runs after that snapshot, pino keeps a reference to the original methods
// and we never see the proof-log events. Order matters here.
import './lib/proof-log'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
