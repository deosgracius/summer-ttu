// pack.js — package the Summer orb as a portable Windows app using ONLY the Electron
// runtime. No electron-builder / electron-packager, so `npm install` has nothing extra
// to audit (the dependency tree is just `electron`). Produces a folder + a zip you can
// copy to any PC; run Summer.exe and it registers itself to start at login.
const fs = require("fs")
const path = require("path")
const { execFileSync } = require("child_process")

const root = __dirname
const electronDist = path.join(root, "node_modules", "electron", "dist")
const distRoot = path.join(root, "dist")
const outDir = path.join(distRoot, "Summer-win32-x64")
const zipPath = path.join(distRoot, "Summer-win-x64.zip")

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true })
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name)
    const d = path.join(dst, e.name)
    if (e.isDirectory()) copyDir(s, d)
    else fs.copyFileSync(s, d)
  }
}

if (!fs.existsSync(path.join(electronDist, "electron.exe"))) {
  console.error("Electron runtime not found — run `npm install` first.")
  process.exit(1)
}

console.log("Cleaning dist…")
fs.rmSync(distRoot, { recursive: true, force: true })

console.log("Copying Electron runtime…")
copyDir(electronDist, outDir)

// The executable users launch is Summer.exe.
fs.renameSync(path.join(outDir, "electron.exe"), path.join(outDir, "Summer.exe"))

// Inject our app so Summer.exe runs it (resources/app takes precedence over the
// built-in default app, which we remove to avoid any fallback ambiguity).
const appDir = path.join(outDir, "resources", "app")
fs.mkdirSync(appDir, { recursive: true })
for (const f of ["main.js", "preload.js"]) {
  fs.copyFileSync(path.join(root, f), path.join(appDir, f))
}
fs.writeFileSync(
  path.join(appDir, "package.json"),
  JSON.stringify(
    { name: "summer-desktop", productName: "Summer", version: "1.0.0", main: "main.js", author: "TTU ECE Summer" },
    null, 2,
  ),
)
fs.rmSync(path.join(outDir, "resources", "default_app.asar"), { force: true })

// Zip with Windows' built-in tar (bsdtar, present on Windows 10/11). It tolerates the
// odd pre-1980 timestamps in the Electron runtime and read-locks that trip up
// Compress-Archive, so the build is reliable.
console.log("Zipping for distribution…")
fs.rmSync(zipPath, { force: true })
execFileSync("tar", ["-a", "-c", "-f", zipPath, "-C", outDir, "."], { stdio: "inherit" })

console.log("\nDone.")
console.log("  App folder : " + outDir)
console.log("  Run        : " + path.join(outDir, "Summer.exe"))
console.log("  Distribute : " + zipPath)
