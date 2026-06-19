import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// Summer is a dark "space console" app — set dark at the root so the full-page
// background glow (the `.dark body` gradient) actually applies everywhere.
document.documentElement.classList.add('dark')

// Note: no <StrictMode> — its dev-only double-mount spun up two speech
// recognizers that fought each other and broke voice listening.
createRoot(document.getElementById('root')!).render(<App />)
