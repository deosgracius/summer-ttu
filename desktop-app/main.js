// Summer floating desktop orb — a thin Electron shell over the LIVE web app.
// It opens a small frameless, transparent, always-on-top window that loads
// https://summer-ttu.fly.dev/desktop, so the orb greets the user and they can talk to
// Summer from a bubble on their desktop. Because it loads the live site, app changes
// you deploy show up automatically on the next reload — you rarely rebuild this shell.
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, shell } = require("electron")
const path = require("path")

const ORIGIN = process.env.SUMMER_ORIGIN || "https://summer-ttu.fly.dev"
const APP_URL = `${ORIGIN}/desktop`

// Let the orb speak on launch without requiring a click first.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required")

// Single instance — clicking the launcher again just reveals the existing orb.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  let win = null
  let tray = null

  function createWindow() {
    win = new BrowserWindow({
      width: 380,
      height: 640,
      frame: false,
      transparent: true,
      resizable: true,
      alwaysOnTop: true,
      backgroundColor: "#00000000",
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    win.setAlwaysOnTop(true, "floating")

    // Bottom-right of the primary display.
    const { workArea } = screen.getPrimaryDisplay()
    win.setPosition(workArea.x + workArea.width - 400, workArea.y + workArea.height - 680)

    // Microphone: grant ONLY for our own origin, nothing else.
    const ses = win.webContents.session
    ses.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === "media"))
    ses.setPermissionCheckHandler((_wc, permission, origin) =>
      permission === "media" && origin.startsWith(ORIGIN))

    // Keep the shell pinned to our app; open any external link in the real browser.
    win.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url)
      return { action: "deny" }
    })
    win.webContents.on("will-navigate", (e, url) => {
      if (!url.startsWith(ORIGIN)) {
        e.preventDefault()
        shell.openExternal(url)
      }
    })

    win.loadURL(APP_URL)
    win.on("closed", () => { win = null })
  }

  function toggle() {
    if (!win) return createWindow()
    if (win.isVisible()) win.hide()
    else { win.show(); win.focus() }
  }

  app.whenReady().then(() => {
    createWindow()

    const img = nativeImage.createFromPath(path.join(__dirname, "icon.png"))
    tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img)
    tray.setToolTip("Summer")
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "Show / Hide", click: toggle },
      { label: "Reload", click: () => win && win.reload() },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ]))
    tray.on("click", toggle)

    ipcMain.on("summer:minimize", () => win && win.minimize())
    ipcMain.on("summer:hide", () => win && win.hide())
  })

  app.on("second-instance", () => { if (win) { win.show(); win.focus() } })
  // Stay alive in the tray when the window is hidden/closed (don't quit).
  app.on("window-all-closed", () => {})
  app.on("activate", () => { if (!win) createWindow() })
}
