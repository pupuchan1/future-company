import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import { VoiceRoom } from './features/voice-room/VoiceRoom.tsx'

// Keep the existing prototype and its URLs usable while the company entrance evolves.
const companyEntrance = location.pathname === '/' || location.pathname === '/index.html'
await (companyEntrance ? import('@/styles/haas.css') : import('@/styles/global.css'))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {companyEntrance ? <VoiceRoom /> : <App />}
  </StrictMode>,
)
