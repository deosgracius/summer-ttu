# Summer wall kiosk — Lenovo ThinkCentre M710q

This is the setup for running Summer on the used **ThinkCentre M710q** (Intel i5-7500T),
replacing the Raspberry Pi. Because it's an ordinary **x86 PC**, the browser gets
hardware-accelerated WebGL out of the box — none of the Pi/Jetson driver drama, no flashing,
no recovery mode. Plan on about **30–45 minutes** end to end.

Summer itself runs in the cloud (`summer-ttu.onrender.com`); this machine is just a browser
pointed at it, all day, unattended.

---

## What you need

- The ThinkCentre, its power adapter, and a keyboard + mouse (just for setup)
- The **TV** (connects by HDMI — the M710q has HDMI + DisplayPort; if you use DisplayPort, a
  DP→HDMI adapter)
- The **eMeet USB speakerphone** (the microphone; audio plays out of the TV over HDMI)
- Ethernet, or Wi-Fi credentials
- The **Ubuntu 22.04 USB stick** you already made (recommended), or use the Windows it ships with

---

## Step 1 — Install Ubuntu (recommended)

The M710q ships with Windows 11, which works, but forced updates and reboots are a nuisance on
an always-on wall display. Ubuntu is cleaner for a kiosk.

1. Boot from the Ubuntu 22.04 USB stick (tap **F12** at the Lenovo logo → pick the USB).
2. Choose **Install Ubuntu**, erase the disk, and let it install.
3. On first boot, create a user — remember the username and password.
4. **Set the timezone to Chicago** when asked (or the setup script fixes it in Step 2).

> Prefer to keep Windows? Skip to [Windows alternative](#windows-alternative) at the bottom.

---

## Step 2 — Run the setup script (one command)

Get this folder onto the machine (clone the repo, or copy the `thinkcentre-kiosk` folder over on
a USB stick), open a terminal in it, and run:

```bash
cd thinkcentre-kiosk
./setup.sh
```

It will, in order:

1. Set the timezone to **America/Chicago** (office-hours status depends on it)
2. Install **Google Chrome** (the x86 build with working GPU acceleration) + display tools
3. Make the kiosk **start automatically at login**
4. Turn on **automatic login** so a power-cycle lands straight on the wall
5. Keep the session on **X11** (WebGL is reliable there)

It asks for your password a few times (it's using `sudo`). Safe to run more than once.

---

## Step 3 — Plug in and reboot

1. Connect the **TV over HDMI** and the **eMeet over USB**.
2. `sudo reboot`

It should boot straight into the Summer kiosk, fullscreen. Say **"Hey Summer"** to test voice —
the wake word arms itself, so nothing needs clicking.

---

## Verify it's actually using the GPU

This is the one thing worth checking, since a smooth 60fps is the whole reason for this machine.
Open a terminal (Ctrl+Alt+T) while the kiosk runs:

- In a separate Chrome window (or `google-chrome-stable chrome://gpu`), the **WebGL** and
  **WebGL2** rows should say *Hardware accelerated* and **GL_RENDERER** should name the Intel
  graphics — **not** "SwiftShader" or "llvmpipe" (those mean software rendering).
- Paste this in DevTools console (F12) on the kiosk page and let it run 10s — expect **~60**:

```js
(()=>{let f=0,t=performance.now();const g=()=>{f++;const d=performance.now()-t;
if(d>=5000){console.log('fps',(f/(d/1000)).toFixed(1));f=0;t=performance.now();}
requestAnimationFrame(g);};requestAnimationFrame(g);})()
```

If it's a smooth 60, you can turn the galaxy and robot visuals back on — this machine has the
headroom the Pi didn't.

---

## The gotchas (learned the hard way on the Pi)

| Thing | Why it matters |
|---|---|
| **Timezone = America/Chicago** | Office-hours "Open now / Closed now" is computed in local time. Wrong zone → wrong status. `setup.sh` sets it. |
| **eMeet is the mic, TV is the speaker** | The eMeet is a single-capture-client USB device; only the browser should hold it. `kiosk.sh` points the default source at it by name and the sink at HDMI. |
| **Pin the TV to 1080p60** | A 4K/30 negotiation is ~6.5× more expensive to render and only 30Hz. `kiosk.sh` forces 1920×1080@60. |
| **Screen blanking** | Disabled in three places (`xset`, GNOME idle, screensaver) so the wall never goes black at 3am. |
| **CMOS battery** | Unlike the Pi, the ThinkCentre keeps time through a power-off via its coin cell. If the clock ever drifts after being unplugged for weeks, replace the CR2032 on the motherboard. |

---

## Everyday operations

- **Change what Summer shows** (people, photos, office hours, imports): the admin site at
  `summer-ttu.onrender.com` → sign in → Directory / Campus Data. Edits appear on the wall within
  ~45 seconds. (You do **not** touch this machine for content.)
- **Restart the kiosk**: `pkill chrome` — it relaunches itself in ~3 seconds. Or `sudo reboot`.
- **Stop autostart temporarily**: delete `~/.config/autostart/summer-kiosk.desktop`.
- **Change the URL**: edit `URL=` at the top of `kiosk.sh`.

---

## Windows alternative

If you keep the pre-installed Windows instead of Ubuntu:

1. Install **Google Chrome**.
2. Set the timezone to **Central Time**.
3. Create a shortcut / startup task that runs Chrome in kiosk mode:
   ```
   chrome.exe --kiosk --autoplay-policy=no-user-gesture-required --use-fake-ui-for-media-stream https://summer-ttu.onrender.com/kiosk
   ```
4. Put that shortcut in the Startup folder (`shell:startup`) and set the account to log in
   automatically.

It works, but expect the occasional Windows-update reboot. Ubuntu is the calmer choice for a
device that runs untouched for months.
