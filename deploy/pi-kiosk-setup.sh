#!/usr/bin/env bash
# Set up a Raspberry Pi 5 as the Summer hallway kiosk.
#
#   curl -fsSL https://raw.githubusercontent.com/deosgracius/summer-ttu/main/deploy/pi-kiosk-setup.sh -o setup.sh
#   bash setup.sh
#
# Run it as the normal desktop user (NOT with sudo) on Raspberry Pi OS 64-bit Desktop. It is
# idempotent: re-running it just rewrites the same config.
#
# What it does, and why each piece matters on a wall display:
#   - launches Chromium in true kiosk mode, so the page fills the screen with no address bar and
#     no black side bars;
#   - pre-grants the microphone, so "Hey Summer" works with no permission popup that nobody is
#     standing there to click;
#   - allows audio to play without a user gesture, so Summer can speak on her own;
#   - stops the screen blanking and hides the mouse cursor;
#   - relaunches Chromium if it ever exits, and starts everything again after a power cut.
set -euo pipefail

KIOSK_URL="${KIOSK_URL:-https://summer-ttu.onrender.com/kiosk}"
USER_NAME="$(id -un)"

if [[ "$USER_NAME" == "root" ]]; then
  echo "Run this as your normal desktop user, not with sudo." >&2
  exit 1
fi

echo "==> Installing Chromium and unclutter"
sudo apt-get update -qq
# chromium-browser is a transitional name on Bookworm; install whichever exists.
sudo apt-get install -y chromium || sudo apt-get install -y chromium-browser
sudo apt-get install -y unclutter-xfixes || sudo apt-get install -y unclutter || true

CHROME_BIN="$(command -v chromium || command -v chromium-browser)"
echo "    using: $CHROME_BIN"

echo "==> Disabling screen blanking"
# raspi-config's own switch, so it survives OS updates that rewrite the compositor config.
sudo raspi-config nonint do_blanking 1 || echo "    (skipped: raspi-config not available)"

echo "==> Writing the kiosk launcher"
mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/summer-kiosk.sh" <<EOF
#!/usr/bin/env bash
# Launch loop: if Chromium is closed or crashes, bring it straight back. A kiosk with no keyboard
# has nobody to restart it.
URL="\${KIOSK_URL:-$KIOSK_URL}"

# Hide the mouse pointer (it otherwise sits in the middle of the screen forever).
(command -v unclutter >/dev/null && unclutter --timeout 1 >/dev/null 2>&1 &) || true

while true; do
  # A previous unclean shutdown makes Chromium show a "restore pages?" bar, which would sit on the
  # wall until someone dismissed it. Clear those flags before every launch.
  PROFILE="\$HOME/.config/chromium/Default/Preferences"
  if [ -f "\$PROFILE" ]; then
    sed -i 's/"exit_type":"Crashed"/"exit_type":"Normal"/; s/"exited_cleanly":false/"exited_cleanly":true/' "\$PROFILE" || true
  fi

  "$CHROME_BIN" \\
    --kiosk "\$URL" \\
    --noerrdialogs \\
    --disable-infobars \\
    --disable-session-crashed-bubble \\
    --disable-features=Translate,TranslateUI \\
    --check-for-update-interval=31536000 \\
    --autoplay-policy=no-user-gesture-required \\
    --use-fake-ui-for-media-stream \\
    --start-fullscreen \\
    --password-store=basic

  # Chromium exited (crash, or someone closed it). Pause briefly, then relaunch.
  sleep 5
done
EOF
chmod +x "$HOME/.local/bin/summer-kiosk.sh"

echo "==> Registering it to start with the desktop session"
# A .desktop autostart entry works on both the Wayland (labwc/wayfire) and X11 sessions that
# Raspberry Pi OS ships, so this keeps working across OS updates.
mkdir -p "$HOME/.config/autostart"
cat > "$HOME/.config/autostart/summer-kiosk.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Summer Kiosk
Exec=$HOME/.local/bin/summer-kiosk.sh
X-GNOME-Autostart-enabled=true
EOF

cat <<EOF

==> Done.

  URL      : $KIOSK_URL
  Launcher : $HOME/.local/bin/summer-kiosk.sh
  Autostart: $HOME/.config/autostart/summer-kiosk.desktop

Reboot to test the full path (power cut -> boots -> kiosk on screen):

  sudo reboot

To point it somewhere else later:

  KIOSK_URL=https://example.org/kiosk bash setup.sh

Two things this script cannot do for you:
  1. Set the TV to "Screen Fit" / "Just Scan" in its picture settings, or the TV itself will
     letterbox the image no matter what the Pi outputs.
  2. Confirm the microphone is the DEFAULT input device. Check with:
       arecord -l                # is the mic listed?
       alsamixer                 # F4 for capture, make sure it isn't muted
EOF
