import os
from pydantic import BaseModel
from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.orm import Session
import json
from .. import models, schemas, auth
from ..database import get_db

router = APIRouter(prefix="/auth", tags=["auth"])

def _out(user):
    try:
        prof = json.loads(user.profile_json or "{}")
    except Exception:
        prof = {}
    return {"id": user.id, "email": user.email, "role": user.role,
            "timezone": user.timezone, "location": user.location, "profile": prof}


@router.post("/register", response_model=schemas.UserOut, status_code=201)
def register(data: schemas.UserCreate, db: Session = Depends(get_db)):
    if db.query(models.User).filter(models.User.email == data.email).first():
        raise HTTPException(400, "Email already registered")
    # SECURITY: public sign-up always creates the lowest role. Elevated access
    # (client/admin/central_admin) is granted only by a central admin via
    # /admin/assign-role — you can never self-promote. This is what makes
    # "nothing changes without the central admin's approval" enforceable.
    role = "customer"
    user = models.User(email=data.email, password_hash=auth.hash_password(data.password),
                       role=role, timezone=data.timezone or "UTC", location=data.location or "")
    if getattr(data, "profile", None):
        user.profile_json = json.dumps(data.profile)
    db.add(user); db.commit(); db.refresh(user)
    return _out(user)


@router.post("/login")
def login(form: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(get_db)):
    user = db.query(models.User).filter(models.User.email == form.username).first()
    if not user or not auth.verify_password(form.password, user.password_hash):
        raise HTTPException(401, "Incorrect email or password")
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
def login_mfa(data: MfaLogin, db: Session = Depends(get_db)):
    """Second login step: password + authenticator/recovery code. If the user
    also has a passkey, returns a passkey challenge (the 3rd factor) instead of a
    token; otherwise returns the token."""
    from .. import security, webauthn_svc
    user = db.query(models.User).filter(models.User.email == data.email).first()
    if not user or not auth.verify_password(data.password, user.password_hash):
        raise HTTPException(401, "Incorrect email or password")
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
def login_passkey(data: PasskeyLogin, db: Session = Depends(get_db)):
    """Final login step: verify the passkey assertion, then issue the token."""
    from .. import security, webauthn_svc
    user = db.query(models.User).filter(models.User.email == data.email).first()
    if not user or not auth.verify_password(data.password, user.password_hash):
        raise HTTPException(401, "Incorrect email or password")
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
def forgot(data: ForgotReq, db: Session = Depends(get_db)):
    u = db.query(models.User).filter_by(email=data.email).first()
    if not u:
        return {"ok": True}
    token = auth.create_reset_token(u.id)
    link = f"{os.getenv('APP_URL', 'http://localhost:8000')}/ui/?reset={token}"
    from .. import mailer
    body = f"Reset your Summer password using this link (valid 30 min):\n\n{link}"
    sent = mailer.send_text([u.email], "Reset your Summer password", body)
    resp = {"ok": True, "emailed": bool(sent)}
    if not sent:
        resp["dev_link"] = link  # SMTP not configured: shown so you can still test
    return resp


@router.post("/reset")
def reset(data: ResetReq, db: Session = Depends(get_db)):
    uid = auth.verify_reset_token(data.token)
    if not uid:
        return {"error": "invalid or expired reset link"}
    u = db.get(models.User, uid)
    if not u:
        return {"error": "user not found"}
    if len(data.new_password) < 6:
        return {"error": "password must be at least 6 characters"}
    u.password_hash = auth.hash_password(data.new_password); db.commit()
    return {"reset": True}


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
