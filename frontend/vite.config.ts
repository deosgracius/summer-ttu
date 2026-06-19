import path from "path"
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    // Forward backend calls to FastAPI (running on :8000) during local dev,
    // so fetch("/auth/..."), fetch("/events/..."), etc. work with no CORS setup.
    proxy: {
      "/auth": "http://localhost:8000",
      "/agent": "http://localhost:8000",
      "/vision": "http://localhost:8000",
      "/tasks": "http://localhost:8000",
      "/reminders": "http://localhost:8000",
      "/emails": "http://localhost:8000",
      "/memories": "http://localhost:8000",
      "/events": "http://localhost:8000",
      "/content": "http://localhost:8000",
      "/admin": "http://localhost:8000",
      "/campus": "http://localhost:8000",
      "/security": "http://localhost:8000",
      // only the API calls, NOT the /kiosk page route (which React Router serves)
      "/kiosk/ask": "http://localhost:8000",
      "/kiosk/tts": "http://localhost:8000",
      "/voice": "http://localhost:8000",
      "/payments": "http://localhost:8000",
      "/oauth": "http://localhost:8000",
      "/docs": "http://localhost:8000",
      "/openapi.json": "http://localhost:8000",
      "/ws": { target: "ws://localhost:8000", ws: true },
    },
  },
})
