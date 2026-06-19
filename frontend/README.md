# SUMMER — Frontend (React + Vite + Tailwind + shadcn/ui)

Modern UI layer for the SUMMER app. This is where 21st.dev ("Magic") components live.

## Run it

```bash
cd summer_app/frontend
npm install      # first time only
npm run dev      # starts http://localhost:5173
```

Keep the FastAPI backend running too (in another terminal):

```bash
cd summer_app
uvicorn app.main:app --reload   # http://localhost:8000
```

The Vite dev server proxies `/auth`, `/events`, `/admin`, `/content`, `/docs`
to the backend on :8000 (see `vite.config.ts`), so `fetch("/auth/login")` etc.
just work — no CORS setup needed.

## Add a component from 21st.dev

1. Browse https://21st.dev/community/components and open a component you like.
2. Copy its install command (looks like the one below) and run it here:

```bash
npx shadcn@latest add "https://21st.dev/r/<author>/<component>"
```

It drops the component as editable code under `src/components/`, installs any
npm deps automatically, and uses the theme tokens already in `src/index.css`.

Add a plain shadcn primitive the same way: `npx shadcn@latest add dialog input ...`

## What's already here

- `src/components/ui/`            — shadcn primitives (button, card)
- `src/components/notification-center.tsx` — example 21st.dev component
- `src/App.tsx`                   — demo landing page wiring it together
- `src/index.css`                 — Tailwind v4 + theme tokens (light/dark)

## Build for production

```bash
npm run build    # outputs to dist/
```
