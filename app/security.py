"""Multi-factor security (Phase 2): authenticator (TOTP) factor, one-time
recovery codes, and step-up re-verification for sensitive actions.

Passkeys/WebAuthn (the third factor) are layered on in Phase 2b; this module
already exposes the shared step-up/enrollment state they'll plug into.
"""
import os
import json
import secrets
import datetime
import pyotp
from fastapi import Depends, HTTPException
from sqlalchemy.orm import Session
from . import models, auth
from .database import get_db

ISSUER = os.getenv("MFA_ISSUER", "Summer (TTU)")
# How long a step-up stays fresh. With a passkey (2b) this becomes a per-action
# tap; with TOTP a short window keeps it from being a code-per-click slog.
STEPUP_WINDOW_SECONDS = int(os.getenv("MFA_STEPUP_SECONDS", "120"))
RECOVERY_CODE_COUNT = 10


def get_security(db, user) -> models.UserSecurity | None:
    return db.get(models.UserSecurity, user.id)


def _ensure(db, user) -> models.UserSecurity:
    sec = db.get(models.UserSecurity, user.id)
    if not sec:
        sec = models.UserSecurity(user_id=user.id)
        db.add(sec)
        db.commit()
        db.refresh(sec)
    return sec


def has_passkey(db, user) -> bool:
    return db.query(models.WebAuthnCredential).filter_by(user_id=user.id).count() > 0


def mfa_enabled(db, user) -> bool:
    sec = get_security(db, user)
    return bool(sec and sec.totp_enabled) or has_passkey(db, user)


# --- TOTP enrollment ------------------------------------------------------

def totp_setup(db, user):
    """Begin authenticator enrollment: create a pending secret + provisioning URI
    (the frontend renders it as a QR for Google Authenticator/Authy)."""
    sec = _ensure(db, user)
    secret = pyotp.random_base32()
    sec.totp_pending = secret
    db.commit()
    uri = pyotp.TOTP(secret).provisioning_uri(name=user.email, issuer_name=ISSUER)
    return {"secret": secret, "otpauth_uri": uri}


def _new_recovery_codes():
    """Return (plaintext list shown once, hashed list to store)."""
    plain = [f"{secrets.token_hex(2)}-{secrets.token_hex(2)}" for _ in range(RECOVERY_CODE_COUNT)]
    hashed = [auth.hash_password(c) for c in plain]
    return plain, hashed


def totp_verify_and_enable(db, user, code):
    """Confirm the pending secret with a live code, then enable TOTP and issue
    one-time recovery codes (returned ONCE)."""
    sec = _ensure(db, user)
    if not sec.totp_pending:
        raise HTTPException(400, "Start authenticator setup first.")
    if not pyotp.TOTP(sec.totp_pending).verify((code or "").strip(), valid_window=1):
        raise HTTPException(400, "That code didn't match. Try the current one.")
    sec.totp_secret = sec.totp_pending
    sec.totp_pending = None
    sec.totp_enabled = True
    plain, hashed = _new_recovery_codes()
    sec.recovery_codes = json.dumps(hashed)
    sec.stepup_at = datetime.datetime.utcnow()  # enrolling counts as a fresh step-up
    db.commit()
    return {"enabled": True, "recovery_codes": plain}


def disable_totp(db, user):
    sec = get_security(db, user)
    if sec:
        sec.totp_secret = None
        sec.totp_pending = None
        sec.totp_enabled = False
        sec.recovery_codes = "[]"
        db.commit()
    return {"enabled": False}


def regenerate_recovery(db, user):
    sec = _ensure(db, user)
    plain, hashed = _new_recovery_codes()
    sec.recovery_codes = json.dumps(hashed)
    db.commit()
    return {"recovery_codes": plain}


# --- Factor verification (used by login second step AND step-up) ----------

def verify_factor(db, user, code) -> bool:
    """True if `code` is a valid current TOTP code or an unused recovery code
    (recovery codes are consumed on use)."""
    sec = get_security(db, user)
    if not sec or not sec.totp_enabled:
        return False
    code = (code or "").strip().replace(" ", "")
    if sec.totp_secret and pyotp.TOTP(sec.totp_secret).verify(code, valid_window=1):
        return True
    codes = json.loads(sec.recovery_codes or "[]")
    for h in list(codes):
        if auth.verify_password(code, h):
            codes.remove(h)
            sec.recovery_codes = json.dumps(codes)
            db.commit()
            return True
    return False


def mark_stepup(db, user):
    sec = _ensure(db, user)
    sec.stepup_at = datetime.datetime.utcnow()
    db.commit()


def stepup_fresh(db, user) -> bool:
    sec = get_security(db, user)
    if not sec or not sec.stepup_at:
        return False
    age = (datetime.datetime.utcnow() - sec.stepup_at).total_seconds()
    return age <= STEPUP_WINDOW_SECONDS


def status(db, user):
    sec = get_security(db, user)
    return {
        "totp_enabled": bool(sec and sec.totp_enabled),
        "passkeys": db.query(models.WebAuthnCredential).filter_by(user_id=user.id).count(),
        "mfa_enabled": mfa_enabled(db, user),
        "recovery_remaining": len(json.loads(sec.recovery_codes)) if sec and sec.recovery_codes else 0,
    }


def require_stepup(user: models.User = Depends(auth.get_current_user),
                   db: Session = Depends(get_db)) -> models.User:
    """Dependency for sensitive actions: if the user has MFA, they must have a
    fresh step-up. Users without MFA pass through (so the app still works before
    anyone enrolls). A 401 with X-StepUp:required tells the UI to re-verify."""
    if mfa_enabled(db, user) and not stepup_fresh(db, user):
        raise HTTPException(401, "Step-up verification required",
                            headers={"X-StepUp": "required"})
    return user
