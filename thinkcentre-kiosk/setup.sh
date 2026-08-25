#!/usr/bin/env bash
# One-time setup for the Summer wall kiosk on a Lenovo ThinkCentre M710q running Ubuntu 22.04+.
#
# Run this ONCE, from this folder, as the user who will run the kiosk:
#     cd thinkcentre-kiosk && ./setup.sh
# It installs Google Chrome, fixes the timezone, makes the kiosk start at every login, and turns
# on automatic login so a power-cycle lands straight on the wall. Safe to re-run.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"

echo "== 1/5  Timezone -> America/Chicago =="
# Office-hours ("Open now" / "Closed now") are computed in local time; the wrong zone shows the
# wrong status. (Unlike the Pi, the ThinkCentre has a CMOS battery, so the clock survives power-off.)
sudo timedatectl set-timezone America/Chicago

echo "== 2/5  Google Chrome (x86 build — GPU-accelerated WebGL out of the box) + tools =="
if ! command -v google-chrome-stable >/dev/null 2>&1; then
  tmp="$(mktemp -d)"
  wget -qO "$tmp/chrome.deb" https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
  sudo apt-get update -y
  # x11-xserver-utils gives us xrandr + xset (display mode + blanking control).
  sudo apt-get install -y "$tmp/chrome.deb" x11-xserver-utils
  rm -rf "$tmp"
else
  echo "   Chrome already installed — skipping."
fi

echo "== 3/5  Start the kiosk automatically at login =="
chmod +x "$HERE/kiosk.sh"
mkdir -p "$HOME/.config/autostart"
cat > "$HOME/.config/autostart/summer-kiosk.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Summer Kiosk
Comment=Fullscreen Summer campus kiosk
Exec=$HERE/kiosk.sh
X-GNOME-Autostart-enabled=true
NoDisplay=true
EOF

echo "== 4/5  Automatic login (so a reboot lands on the kiosk, no password needed) =="
if [ -f /etc/gdm3/custom.conf ]; then
  sudo sed -i 's/^#\?\s*AutomaticLoginEnable\s*=.*/AutomaticLoginEnable=true/' /etc/gdm3/custom.conf
  sudo sed -i "s/^#\?\s*AutomaticLogin\s*=.*/AutomaticLogin=$USER/" /etc/gdm3/custom.conf
  grep -q '^AutomaticLoginEnable' /etc/gdm3/custom.conf \
    || sudo sed -i "/^\[daemon\]/a AutomaticLoginEnable=true\nAutomaticLogin=$USER" /etc/gdm3/custom.conf
  echo "   Automatic login enabled for user: $USER"
else
  echo "   (No GDM config found — turn on Automatic Login in Settings > Users manually.)"
fi

echo "== 5/5  Stay on X11 (WebGL is reliable there; Wayland kiosk mode is fussier) =="
if [ -f /etc/gdm3/custom.conf ]; then
  sudo sed -i 's/^#\?\s*WaylandEnable\s*=.*/WaylandEnable=false/' /etc/gdm3/custom.conf
  grep -q '^WaylandEnable' /etc/gdm3/custom.conf \
    || sudo sed -i "/^\[daemon\]/a WaylandEnable=false" /etc/gdm3/custom.conf
fi

echo
echo "All set. Plug the eMeet (USB) and the TV (HDMI) in, then reboot to test:"
echo "    sudo reboot"
echo
echo "After it boots you should see the Summer kiosk fullscreen. Say \"Hey Summer\" to test voice."
