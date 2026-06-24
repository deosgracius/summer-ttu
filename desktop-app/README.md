# Summer — floating desktop orb (Electron)

A small always-on-top "bubble" that floats on the desktop: the orb greets you, gives
your briefing, and lets you talk to Summer by voice — without opening a browser.

It is a **thin shell**: the window just loads the live app at
`https://summer-ttu.fly.dev/desktop`. That has two consequences worth knowing:

- **Updates are automatic.** When you deploy changes to the website, the orb shows them
  on its next reload (tray → Reload, or restart). You only rebuild/reinstall this shell
  if you change the *window* behavior in `main.js` — which is rare.
- **Sign in once.** The login is remembered in the app's own storage, so it stays signed
  in across restarts.

## Try it (developer)

Needs Node.js.

```bash
cd desktop-app
npm install
npm start
```

A floating orb appears bottom-right, always on top. Drag it by the top strip; minimize
or hide it with the buttons; reopen from the tray icon.

## Build an installer (to put it on a PC)

```bash
cd desktop-app
npm install
npm run dist
```

This produces `desktop-app/dist/Summer Setup <version>.exe`. Run it on the target PC —
it installs **per-user (no administrator rights)** and adds Start-menu and desktop
shortcuts.

**Starts with Windows automatically.** On its first run the orb registers itself to
open at login (per-user, via the OS login items). Toggle it any time from the tray menu
→ **Start with Windows**. So once installed, the orb greets the user at every boot with
no extra setup.

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
