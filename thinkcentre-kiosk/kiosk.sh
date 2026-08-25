#!/usr/bin/env bash
# Summer wall-kiosk launcher for the Lenovo ThinkCentre M710q (x86 Ubuntu).
#
# Runs inside the logged-in desktop session (started by ~/.config/autostart/summer-kiosk.desktop,
# which setup.sh installs). It pins the TV to 1080p60, kills every screen-blanking path, points
# the mic/speaker at the right devices, then keeps Chrome up in fullscreen kiosk mode forever —
# relaunching it if it ever crashes. On x86 with Google Chrome, WebGL is GPU-accelerated out of
# the box, so none of the ARM/Tegra --use-gl flags the Pi/Jetson needed are here.
set -u

URL="https://summer-ttu.onrender.com/kiosk"
PROFILE="$HOME/.config/summer-kiosk"
mkdir -p "$PROFILE"

# --- Display: pin the TV to 1920x1080 @ 60Hz. A 4K/30 EDID negotiation is far more expensive to
#     render (measured 6.5x on the Pi) and only 30Hz; 1080p60 is smoother AND cheaper. -----------
OUT="$(xrandr 2>/dev/null | awk '/ connected/{print $1; exit}')"
if [ -n "${OUT:-}" ]; then
  xrandr --output "$OUT" --mode 1920x1080 --rate 60 2>/dev/null || true
fi

# --- Never blank / sleep / lock the screen (three independent layers — miss one and it goes
#     black at 3am). --------------------------------------------------------------------------
xset s off -dpms s noblank 2>/dev/null || true
gsettings set org.gnome.desktop.session idle-delay 'uint32 0' 2>/dev/null || true
gsettings set org.gnome.desktop.screensaver lock-enabled false 2>/dev/null || true
gsettings set org.gnome.desktop.screensaver idle-activation-enabled false 2>/dev/null || true

# --- Audio: the eMeet USB speakerphone is the MIC; the TV over HDMI is the OUTPUT. Pick them by
#     name (USB order isn't stable across reboots). Chrome then follows these defaults. ---------
SRC="$(pactl list short sources 2>/dev/null | grep -i 'emeet\|officecore' | grep -iv monitor | awk '{print $2}' | head -1)"
[ -n "${SRC:-}" ] && pactl set-default-source "$SRC" 2>/dev/null || true
SINK="$(pactl list short sinks 2>/dev/null | grep -i hdmi | awk '{print $2}' | head -1)"
[ -n "${SINK:-}" ] && pactl set-default-sink "$SINK" 2>/dev/null || true

# --- Keep Chrome up. --use-fake-ui-for-media-stream auto-grants the mic (no popup nobody can
#     click); the hands-free wake word arms itself on load, so a crash+relaunch needs no touch. --
CHROME="$(command -v google-chrome-stable || command -v google-chrome || command -v chromium-browser || echo google-chrome-stable)"
while true; do
  "$CHROME" \
    --kiosk \
    --noerrdialogs --disable-infobars --no-first-run --no-default-browser-check \
    --autoplay-policy=no-user-gesture-required \
    --use-fake-ui-for-media-stream \
    --disable-session-crashed-bubble --disable-features=Translate \
    --check-for-update-interval=31536000 \
    --user-data-dir="$PROFILE" \
    "$URL"
  # If Chrome exits (crash, GPU reset, manual quit) wait a moment and bring it back.
  sleep 3
done
