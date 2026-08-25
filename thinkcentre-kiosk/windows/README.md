# Summer wall kiosk on Windows (Lenovo ThinkCentre M710q)

The ThinkCentre ships with Windows 11 Pro, and that's all Summer needs — Chrome on
Windows uses the Intel HD 630 GPU for WebGL automatically, so the galaxy/orb runs
smooth with no driver work. This is the **no-Ubuntu** path: keep the factory Windows,
do the eight one-time steps below, and every power-on lands straight on the kiosk.

Everything here is done once. After that the wall is hands-off: power it on, it logs
in by itself, Chrome opens fullscreen on `https://summer-ttu.onrender.com/kiosk`, and
the wake word arms itself. If Chrome ever crashes, [`kiosk.bat`](kiosk.bat) reopens it.

---

## One-time setup

### 1. Install Google Chrome
Download from https://www.google.com/chrome/ and install. (Edge would also work, but
the launcher and all our testing target Chrome.)

### 2. Set the time zone to Central
Office-hours ("Open now" / "Closed now") are computed in local time — the wrong zone
shows the wrong status. Settings → Time & language → Date & time → **Time zone =
(UTC-06:00) Central Time (US & Canada)**. Leave "Set time automatically" on.

(Or, in an Admin PowerShell: `tzutil /s "Central Standard Time"`.)

### 3. Never sleep, never blank the screen
Settings → System → Power → **Screen and sleep**: set all four drop-downs
(screen off / sleep, on battery and plugged in) to **Never**.

Then disable the lock screen so a stray key never covers the wall:
Settings → Accounts → Sign-in options → **If you've been away, when should Windows
require you to sign in again? = Never**.

### 4. Allow the microphone
Settings → Privacy & security → **Microphone**: turn ON "Microphone access" and
"Let apps access your microphone" and "Let desktop apps access your microphone".
(The launcher also auto-grants Chrome's own mic prompt, but Windows must allow it first.)

### 5. Point audio at the right devices
Plug in the **eMeet USB speakerphone** (the mic) and connect the **TV over HDMI**
(the speaker). Then Settings → System → Sound:
- **Output** = the TV / HDMI device
- **Input** = eMeet / OfficeCore

If the TV has no speakers, leave Output on the eMeet — it plays audio too.

### 6. Turn on automatic login
So a power-cycle reaches the kiosk with no password typed. In an Admin PowerShell run
`netplwiz`, select your user, **uncheck** "Users must enter a user name and password to
use this computer", click Apply, and enter the password once when prompted. (If that
checkbox is missing, it's hidden by Windows Hello: Settings → Accounts → Sign-in
options → turn OFF "For improved security, allow Windows Hello sign-in… " first, then
reopen `netplwiz`.)

### 7. Start the kiosk at every login
Press **Win + R**, type `shell:startup`, Enter — that opens the Startup folder.
Right-drag [`kiosk.bat`](kiosk.bat) into it and choose **Create shortcuts here**
(a shortcut, so the script stays in the repo folder). Now it launches at every login.

### 8. Keep Windows Update from rebooting mid-day
This is the one real Windows-kiosk chore. Settings → Windows Update → **Active hours**:
set them to cover the hours the wall is used (e.g. 7 AM – 10 PM) so updates never reboot
during the day. Leave updates ON — they keep Chrome and the OS patched.

---

## Test it
Reboot. You should land on the fullscreen Summer kiosk with no typing. Say **"Hey
Summer"** and ask a question (e.g. "who is Dylan Tarter?") to confirm mic + audio.

## Day-to-day
- **Exit the kiosk** (for maintenance): `Alt + F4`, then close the console window that
  reopens Chrome. Or `Ctrl + Alt + Del` → Task Manager → end `chrome.exe`.
- **Change the URL** (e.g. to a staging build): edit the `URL=` line in `kiosk.bat`.
- **Content updates** (people, photos, office hours) come from the admin dashboard and
  appear on the kiosk within about a minute of a Render deploy — no touch to this PC.
