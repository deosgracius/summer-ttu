import os
import hmac
from pydantic import BaseModel
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.orm import Session
import json
from .. import models, schemas, auth, ratelimit
from ..database import get_db

router = APIRouter(prefix="/auth", tags=["auth"])

# Brute-force / abuse guards on the public auth surface (per client IP).
LOGIN_MAX = int(os.getenv("LOGIN_PER_MIN", "10"))      # password attempts / min
REGISTER_MAX = int(os.getenv("REGISTER_PER_MIN", "5"))  # new accounts / min
CENTRAL_MAX = int(os.getenv("CENTRAL_PASSCODE_PER_MIN", "5"))  # passcode tries / min


def _reset_link(token: str) -> str:
    return f"{os.getenv('APP_URL', 'http://localhost:8000')}/ui/?reset={token}"


def _central_passcode_ok(passcode: str) -> bool:
    """Constant-time check of the one-time central passcode (the CENTRAL_ADMIN_PASSWORD
    Fly secret). Returns False if the secret is unset, so an empty passcode never
    passes. The passcode is NEVER logged and is usable ONLY for central register/reset
    — it is not a login credential."""
    expected = os.getenv("CENTRAL_ADMIN_PASSWORD", "")
    return bool(expected) and hmac.compare_digest((passcode or "").encode(), expected.encode())

def _out(user):
    try:
        prof = json.loads(user.profile_json or "{}")
    except Exception:
        prof = {}
    return {"id": user.id, "email": user.email, "role": user.role,
            "timezone": user.timezone, "location": user.location, "profile": prof}


@router.post("/register", response_model=schemas.UserOut, status_code=201)
def register(data: schemas.UserCreate, request: Request, db: Session = Depends(get_db)):
    ratelimit.check(f"register:{ratelimit.client_ip(request)}", REGISTER_MAX)
    if db.query(models.User).filter(models.User.email == data.email).first():
        raise HTTPException(400, "Email already registered")
    # SECURITY: public sign-up always creates the lowest role. Elevated access
    # (client/admin/central_admin) is granted only by a central admin via
    # /admin/assign-role — you can never self-promote. This is what makes
    # "nothing changes without the central admin's approval" enforceable.
    role = "customer"
    # The very first account ever created bootstraps the system and is auto-approved;
    # every later public sign-up is held until a central admin approves it.
    first_user = db.query(models.User).count() == 0
    user = models.User(email=data.email, password_hash=auth.hash_password(data.password),
                       role=role, timezone=data.timezone or "UTC", location=data.location or "",
                       approved=first_user)
    if getattr(data, "profile", None):
        user.profile_json = json.dumps(data.profile)
    db.add(user); db.commit(); db.refresh(user)
    return _out(user)


# Message shown when an account exists but hasn't been approved yet.
PENDING_MSG = "Your account is awaiting administrator approval. You'll be able to sign in once it's approved."


@router.post("/login")
def login(request: Request, form: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(get_db)):
    ratelimit.check(f"login:{ratelimit.client_ip(request)}", LOGIN_MAX)
    user = db.query(models.User).filter(models.User.email == form.username).first()
    if not user or not auth.verify_password(form.password, user.password_hash):
        raise HTTPException(401, "Incorrect email or password")
    if not getattr(user, "approved", True):
        raise HTTPException(403, PENDING_MSG)
    # If MFA is enabled, the password alone is NOT enough — a second factor is
    # required at /auth/login/mfa. A stolen password gets nowhere on its own.
    from .. import security
    if security.mfa_enabled(db, user):
        return {"mfa_required": True, "email": user.email}
    return {"access_token": auth.create_token(user.id), "token_type": "bearer"}


class MfaLogin(BaseModel):
    email: str
    password: str
    code: str = ""


@router.post("/login/mfa")
def login_mfa(data: MfaLogin, request: Request, db: Session = Depends(get_db)):
    ratelimit.check(f"login:{ratelimit.client_ip(request)}", LOGIN_MAX)
    """Second login step: password + authenticator/recovery code. If the user
    also has a passkey, returns a passkey challenge (the 3rd factor) instead of a
    token; otherwise returns the token."""
    from .. import security, webauthn_svc
    user = db.query(models.User).filter(models.User.email == data.email).first()
    if not user or not auth.verify_password(data.password, user.password_hash):
        raise HTTPException(401, "Incorrect email or password")
    if not getattr(user, "approved", True):
        raise HTTPException(403, PENDING_MSG)
    sec = security.get_security(db, user)
    if sec and sec.totp_enabled and not security.verify_factor(db, user, data.code):
        raise HTTPException(401, "Invalid verification code")
    if security.has_passkey(db, user):
        return {"passkey_required": True, "email": user.email,
                "options": webauthn_svc.auth_begin(db, user)}
    security.mark_stepup(db, user)  # a fresh login is also a fresh step-up
    return {"access_token": auth.create_token(user.id), "token_type": "bearer"}


class PasskeyLogin(BaseModel):
    email: str
    password: str
    credential: dict


@router.post("/login/passkey", response_model=schemas.Token)
def login_passkey(data: PasskeyLogin, request: Request, db: Session = Depends(get_db)):
    """Final login step: verify the passkey assertion, then issue the token."""
    ratelimit.check(f"login:{ratelimit.client_ip(request)}", LOGIN_MAX)
    from .. import security, webauthn_svc
    user = db.query(models.User).filter(models.User.email == data.email).first()
    if not user or not auth.verify_password(data.password, user.password_hash):
        raise HTTPException(401, "Incorrect email or password")
    if not getattr(user, "approved", True):
        raise HTTPException(403, PENDING_MSG)
    webauthn_svc.auth_verify(db, user, data.credential)  # raises on failure; marks step-up
    return schemas.Token(access_token=auth.create_token(user.id))


@router.get("/me", response_model=schemas.UserOut)
def me(user: models.User = Depends(auth.get_current_user)):
    return _out(user)


@router.patch("/me", response_model=schemas.UserOut)
def update_me(data: schemas.ProfileUpdate, db: Session = Depends(get_db),
              user: models.User = Depends(auth.get_current_user)):
    if data.timezone is not None:
        user.timezone = data.timezone
    if data.location is not None:
        user.location = data.location
    if data.profile is not None:
        try:
            cur = json.loads(user.profile_json or "{}")
        except Exception:
            cur = {}
        cur.update(data.profile)
        user.profile_json = json.dumps(cur)
    db.commit(); db.refresh(user)
    return _out(user)


class ForgotReq(BaseModel):
    email: str


class ResetReq(BaseModel):
    token: str
    new_password: str


@router.post("/forgot")
def forgot(data: ForgotReq, request: Request, db: Session = Depends(get_db)):
    # Rate-limit so the reset flow can't be used to spam mail or probe accounts.
    ratelimit.check(f"forgot:{ratelimit.client_ip(request)}", REGISTER_MAX)
    u = db.query(models.User).filter_by(email=data.email).first()
    if not u:
        return {"ok": True}
    token = auth.create_reset_token(u.id, u.password_hash)
    link = _reset_link(token)
    from .. import mailer
    body = f"Reset your Summer password using this link (valid 30 min):\n\n{link}"
    sent = mailer.send_text([u.email], "Reset your Summer password", body)
    resp = {"ok": True, "emailed": bool(sent)}
    if not sent:
        resp["dev_link"] = link  # SMTP not configured: shown so you can still test
    return resp


@router.post("/reset")
def reset(data: ResetReq, request: Request, db: Session = Depends(get_db)):
    ratelimit.check(f"reset:{ratelimit.client_ip(request)}", LOGIN_MAX)
    uid = auth.verify_reset_token(data.token, db)
    if not uid:
        return {"error": "invalid or expired reset link"}
    u = db.get(models.User, uid)
    if not u:
        return {"error": "user not found"}
    if len(data.new_password) < 6:
        return {"error": "password must be at least 6 characters"}
    u.password_hash = auth.hash_password(data.new_password); db.commit()
    return {"reset": True}


# ---- Central-admin self-service (passcode-gated) ---------------------------------
# The CENTRAL_ADMIN_PASSWORD secret is a one-time PASSCODE, used ONLY to (1) register
# the central admin the first time, or (2) get a password-reset link. It is never a
# login credential. After registering, the central admin signs in with their own
# email + password like anyone else. Every endpoint is rate-limited and compares the
# passcode in constant time; the passcode is never logged.
class CentralStart(BaseModel):
    passcode: str


@router.post("/central/start")
def central_start(data: CentralStart, request: Request, db: Session = Depends(get_db)):
    """Verify the passcode and report whether a central admin already exists, so the UI
    can offer registration (none yet) or a password reset (one exists)."""
    ratelimit.check(f"central:{ratelimit.client_ip(request)}", CENTRAL_MAX)
    if not _central_passcode_ok(data.passcode):
        raise HTTPException(401, "Incorrect passcode")
    has_account = db.query(models.User).filter_by(role="central_admin").count() > 0
    return {"ok": True, "has_account": has_account}


class CentralRegister(BaseModel):
    passcode: str
    email: str
    password: str
    location: str | None = None
    timezone: str | None = None


@router.post("/central/register")
def central_register(data: CentralRegister, request: Request, db: Session = Depends(get_db)):
    """First-time central-admin registration, gated by the passcode. Creates the
    central_admin (or upgrades an existing account of that email), auto-approved, and
    logs them in. Refuses to create a SECOND central admin under a different email — the
    holder should reset the existing one instead."""
    ratelimit.check(f"central:{ratelimit.client_ip(request)}", CENTRAL_MAX)
    if not _central_passcode_ok(data.passcode):
        raise HTTPException(401, "Incorrect passcode")
    email = (data.email or "").strip().lower()
    if "@" not in email or "." not in email:
        raise HTTPException(400, "Enter a valid email")
    if len(data.password or "") < 8:
        raise HTTPException(400, "Password must be at least 8 characters")
    existing_central = db.query(models.User).filter_by(role="central_admin").first()
    if existing_central and existing_central.email.lower() != email:
        raise HTTPException(409, "A central admin account already exists. Use password reset instead.")
    user = db.query(models.User).filter(models.User.email == email).first()
    if user:
        user.role = "central_admin"
        user.password_hash = auth.hash_password(data.password)
        user.approved = True
        if data.location is not None:
            user.location = data.location
        if data.timezone:
            user.timezone = data.timezone
    else:
        user = models.User(email=email, password_hash=auth.hash_password(data.password),
                           role="central_admin", approved=True,
                           timezone=data.timezone or "UTC", location=data.location or "")
        db.add(user)
    db.commit(); db.refresh(user)
    return {"ok": True, "access_token": auth.create_token(user.id), "token_type": "bearer"}


class CentralResetLink(BaseModel):
    passcode: str
    email: str


@router.post("/central/reset-link")
def central_reset_link(data: CentralResetLink, request: Request, db: Session = Depends(get_db)):
    """Passcode-gated password reset for the central admin: returns a single-use,
    30-minute on-screen reset link (no email needed). The link opens the reset page
    where they set a new password, then sign in normally."""
    ratelimit.check(f"central:{ratelimit.client_ip(request)}", CENTRAL_MAX)
    if not _central_passcode_ok(data.passcode):
        raise HTTPException(401, "Incorrect passcode")
    email = (data.email or "").strip().lower()
    u = db.query(models.User).filter(models.User.email == email).first()
    if not u:
        raise HTTPException(404, "No account found with that email")
    token = auth.create_reset_token(u.id, u.password_hash)
    return {"ok": True, "reset_link": _reset_link(token)}


class PwChange(BaseModel):
    current_password: str
    new_password: str


@router.post("/change-password")
def change_password(data: PwChange, db: Session = Depends(get_db),
                    user: models.User = Depends(auth.get_current_user)):
    if not auth.verify_password(data.current_password, user.password_hash):
        return {"error": "current password is incorrect"}
    if len(data.new_password) < 6:
        return {"error": "new password must be at least 6 characters"}
    user.password_hash = auth.hash_password(data.new_password); db.commit()
    return {"ok": True}


class EmailChange(BaseModel):
    new_email: str
    password: str


@router.post("/change-email")
def change_email(data: EmailChange, db: Session = Depends(get_db),
                 user: models.User = Depends(auth.get_current_user)):
    if not auth.verify_password(data.password, user.password_hash):
        return {"error": "password is incorrect"}
    ne = (data.new_email or "").strip().lower()
    if "@" not in ne or "." not in ne:
        return {"error": "enter a valid email"}
    if db.query(models.User).filter(models.User.email == ne, models.User.id != user.id).first():
        return {"error": "that email is already in use"}
    user.email = ne; db.commit(); db.refresh(user)
    return _out(user)


class PwOnly(BaseModel):
    password: str


@router.post("/delete-account")
def delete_account(data: PwOnly, db: Session = Depends(get_db),
                   user: models.User = Depends(auth.get_current_user)):
    if not auth.verify_password(data.password, user.password_hash):
        return {"error": "password is incorrect"}
    uid = user.id
    for name in ("Task", "Reminder", "EmailDraft", "Memory", "Booking", "ContentDraft"):
        mdl = getattr(models, name, None)
        if mdl is not None:
            try:
                db.query(mdl).filter_by(user_id=uid).delete()
            except Exception:
                db.rollback()
    db.delete(user); db.commit()
    return {"deleted": True}
