"""Two-deputy delegation.

When the central admin is inactive for longer than a configured window, two
designated deputy admins may act in their place — but ONLY together: any pending
change needs BOTH deputies to approve before it applies. While the central admin
is active (or delegation isn't configured), nothing changes: the central admin
approves alone and deputies can't act.

State lives in AppSetting (no schema change):
  deputy_admin_1 / deputy_admin_2  — deputy account emails (lowercased)
  central_absence_minutes          — X: minutes of inactivity before deputies take over
  central_last_seen                — ISO timestamp of the central admin's last activity
  dual_approval:<change_id>        — comma-separated deputy emails that have approved
"""
import datetime

from . import appsettings

K_DEP1 = "deputy_admin_1"
K_DEP2 = "deputy_admin_2"
K_TIMEOUT = "central_absence_minutes"
K_SEEN = "central_last_seen"
_SEEN_THROTTLE_S = 60  # don't rewrite last-seen more than once a minute


def get_config(db) -> dict:
    return {
        "deputy_1": appsettings.get(db, K_DEP1, ""),
        "deputy_2": appsettings.get(db, K_DEP2, ""),
        "absence_minutes": int(appsettings.get(db, K_TIMEOUT, "0") or 0),
    }


def set_config(db, deputy_1: str, deputy_2: str, absence_minutes: int):
    appsettings.set(db, K_DEP1, (deputy_1 or "").strip().lower())
    appsettings.set(db, K_DEP2, (deputy_2 or "").strip().lower())
    appsettings.set(db, K_TIMEOUT, str(max(0, int(absence_minutes or 0))))


def deputies(db) -> set:
    cfg = get_config(db)
    return {e for e in (cfg["deputy_1"], cfg["deputy_2"]) if e}


def is_configured(db) -> bool:
    cfg = get_config(db)
    return bool(cfg["deputy_1"] and cfg["deputy_2"]
               and cfg["deputy_1"] != cfg["deputy_2"] and cfg["absence_minutes"] > 0)


def is_deputy(db, user) -> bool:
    return (getattr(user, "email", "") or "").lower() in deputies(db)


def record_central_seen(db, user):
    """Mark the central admin as active now (throttled). Safe to call on every
    authenticated request; never raises."""
    try:
        if getattr(user, "role", "") != "central_admin":
            return
        now = datetime.datetime.utcnow()
        last = appsettings.get(db, K_SEEN, "")
        if last:
            try:
                if (now - datetime.datetime.fromisoformat(last)).total_seconds() < _SEEN_THROTTLE_S:
                    return
            except ValueError:
                pass
        appsettings.set(db, K_SEEN, now.isoformat())
    except Exception:
        db.rollback()


def central_absent(db) -> bool:
    """True only when delegation is configured AND the central admin has been
    inactive longer than the configured window."""
    if not is_configured(db):
        return False
    last = appsettings.get(db, K_SEEN, "")
    if not last:
        return False  # never seen yet — don't auto-delegate
    try:
        elapsed = (datetime.datetime.utcnow() - datetime.datetime.fromisoformat(last)).total_seconds()
    except ValueError:
        return False
    return elapsed > get_config(db)["absence_minutes"] * 60


def status(db) -> dict:
    cfg = get_config(db)
    return {**cfg, "configured": is_configured(db), "central_absent": central_absent(db),
            "central_last_seen": appsettings.get(db, K_SEEN, "")}


# --- per-change dual-approval tracking -----------------------------------
def _dual_key(change_id: int) -> str:
    return f"dual_approval:{change_id}"


def record_deputy_approval(db, change_id: int, user) -> set:
    key = _dual_key(change_id)
    have = {e for e in appsettings.get(db, key, "").split(",") if e}
    have.add((user.email or "").lower())
    appsettings.set(db, key, ",".join(sorted(have)))
    return have


def both_deputies_approved(db, change_id: int) -> bool:
    deps = deputies(db)
    if len(deps) != 2:
        return False
    have = {e for e in appsettings.get(db, _dual_key(change_id), "").split(",") if e}
    return deps.issubset(have)


def clear_dual(db, change_id: int):
    appsettings.set(db, _dual_key(change_id), "")
