# Summer on a TV (Raspberry Pi kiosk)

Turn a TV + Raspberry Pi into a hallway Summer kiosk. The Pi boots into a full-screen
Chromium showing the **public** kiosk (`https://summer-ttu.fly.dev/kiosk`) — no login,
read-only, restricted to campus lookups. Because it loads the live site, anything you
deploy shows up on the next reload; you don't reinstall anything on the Pi.

## Hardware

- **Raspberry Pi 4 or 5** (Pi 5 recommended), microSD with Raspberry Pi OS (Desktop),
  and the **TV connected by HDMI**.
- **A microphone** — HDMI gives you audio *out* to the TV, but no mic *in*. Add one:
  - **USB conference speakerphone** (e.g. Anker PowerConf, Jabra Speak) — best for a
    hallway: it's the mic *and* a good speaker in one. Set the TV audio aside and use it
    for both in and out.
  - **USB microphone**, or a **USB webcam with a built-in mic** — cheapest; audio still
    plays out of the TV over HDMI.

## Install

Copy this `pi-kiosk` folder to the Pi (or clone the repo), then:

```bash
cd pi-kiosk
bash setup.sh
```

It installs Chromium if needed, writes a launcher (`~/summer-kiosk.sh`), and adds a
login autostart entry. The launcher runs Chromium in kiosk mode with audio autoplay,
**auto-allows the microphone** (`--use-fake-ui-for-media-stream`), and relaunches the
browser if it ever closes.

Then set these once with `sudo raspi-config`:
- **System Options → Boot / Auto Login → Desktop Autologin** — so the Pi boots straight
  into the kiosk with no keyboard.
- **Display Options → Screen Blanking → Off** — so the TV never sleeps.

Reboot, and the TV comes up on Summer. To start it immediately without rebooting:
`~/summer-kiosk.sh &`.

## Audio routing

- **TV speakers (HDMI) for output, USB mic for input:** the default. Set the Pi's audio
  output to HDMI (right-click the volume icon, or `raspi-config` → Audio).
- **USB speakerphone for both:** set the Pi's output to the USB device instead; the TV
  then shows the picture only.

## Voice notes

- **Microphone permission** is granted automatically by the kiosk flags, so there's no
  "allow microphone?" prompt to click.
- **Tap-to-talk / on-screen mic** uses server-side Whisper and works reliably on the Pi,
  and it auto-detects the spoken language.
- The always-listening **"Hey Summer" wake word** relies on the browser's speech service,
  which can be unreliable on Chromium/Linux. For dependable hands-free wake-word, a small
  Windows mini-PC is smoother; on the Pi, the on-screen mic button is the sure path.

## Change the target

`SUMMER_KIOSK_URL=http://<your-server>/kiosk bash setup.sh` (e.g. a local dev server).

## Remove

Delete `~/.config/autostart/summer-kiosk.desktop` and `~/summer-kiosk.sh`.
