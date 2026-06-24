# Summer — floating desktop orb (Electron)

A small always-on-top "bubble" that floats on the desktop: the orb greets you, gives
your briefing, and lets you talk to Summer by voice — without opening a browser.

It is a **thin shell**: the window just loads the live app at
`https://summer-ttu.fly.dev/desktop`. That has two consequences worth knowing:

- **Updates are automatic.** When you deploy changes to the website, the orb shows them
  on its next reload (tray → Reload, or restart). You only rebuild this shell if you
  change the *window* behavior in `main.js` — which is rare.
- **Sign in once.** The login is remembered in the app's own storage, so it stays signed
  in across restarts.

## Clean dependencies

This project depends on **`electron` only** — there is no `electron-builder` or other
packager, so `npm install` reports **0 vulnerabilities**. Packaging is done by a small
local script (`pack.js`) that copies the Electron runtime and zips it.

## Try it (developer)

Needs Node.js.

```bash
cd desktop-app
npm install
npm start
```

A floating orb appears bottom-right, always on top. Drag it by the top strip; minimize
or hide it with the buttons; reopen from the tray icon.

## Build the distributable

```bash
cd desktop-app
npm install
npm run dist
```

`npm run dist` produces, under `desktop-app/dist/`:

- **`Summer-win32-x64/`** — the ready-to-run app folder (`Summer.exe` inside), and
- **`Summer-win-x64.zip`** — the same thing as one file, for copying to other PCs.

## Install on a PC (no admin, no build)

1. Copy **`Summer-win-x64.zip`** to the computer and extract it anywhere
   (e.g. `C:\Users\<you>\Summer`).
2. Run **`Summer.exe`** once and sign in.

On that first run the orb **registers itself to start at Windows login** (per-user, via
the OS login items). Toggle it any time from the tray menu → **Start with Windows**. So
after step 2 it greets you at every boot — nothing else to set up.

> Because it's unsigned, Windows SmartScreen may say "Windows protected your PC" the
> first time — click **More info → Run anyway**. (Code signing needs a paid certificate;
> ask if you want to go that route.)

## Notes

- **Microphone:** the shell grants mic access only to the Summer origin. Windows may
  still ask once to allow the app to use the microphone — allow it.
- **Icon:** add an `icon.png` (256×256) in this folder for a custom tray/app icon; the
  default Electron icon is used if it's absent.
- **Point at a different server:** set `SUMMER_ORIGIN`, e.g.
  `SUMMER_ORIGIN=http://localhost:8000 npm start`.
- **Security:** `contextIsolation` is on with a minimal preload (only window-control
  helpers are exposed); the window is pinned to the Summer origin and opens any external
  link in the real browser.
