"""Control the computer Summer runs on (local only). Fixed safe whitelist; no arbitrary commands.
Gated behind SUMMER_ALLOW_SYSTEM=1 so a deployed server is never controllable."""
import os
import platform
import subprocess

SAFE = {
    "sleep":    {"win": "rundll32.exe powrprof.dll,SetSuspendState 0,1,0", "darwin": "pmset sleepnow",        "linux": "systemctl suspend"},
    "lock":     {"win": "rundll32.exe user32.dll,LockWorkStation",          "darwin": "pmset displaysleepnow", "linux": "loginctl lock-session"},
    "shutdown": {"win": "shutdown /s /t 10",                                 "darwin": "shutdown -h +1",        "linux": "shutdown -h +1"},
    "restart":  {"win": "shutdown /r /t 10",                                 "darwin": "shutdown -r +1",        "linux": "shutdown -r +1"},
    "cancel":   {"win": "shutdown /a",                                       "darwin": "killall shutdown",      "linux": "shutdown -c"},
}


def _osk():
    p = platform.system().lower()
    if "windows" in p:
        return "win"
    if "darwin" in p:
        return "darwin"
    return "linux"


def control(action):
    if os.getenv("SUMMER_ALLOW_SYSTEM", "0") != "1":
        return {"error": "Computer control is turned off. Set the env var SUMMER_ALLOW_SYSTEM=1 to let Summer control this PC."}
    action = (action or "").lower().strip()
    if action not in SAFE:
        return {"error": f"Unsupported action. Allowed: {', '.join(SAFE)}."}
    cmd = SAFE[action][_osk()]
    try:
        subprocess.Popen(cmd, shell=True)
        if action in ("shutdown", "restart"):
            return {"ok": True, "action": action, "note": "Starting in ~10 seconds. Say 'cancel' to abort."}
        return {"ok": True, "action": action}
    except Exception as e:
        return {"error": f"Couldn't {action}: {e}"}
