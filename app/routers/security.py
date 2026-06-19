"""Self-service multi-factor security endpoints (Phase 2a: authenticator + recovery
codes + step-up). Passkey/WebAuthn endpoints are added in Phase 2b."""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from .. import models, security, audit, webauthn_svc
from ..database import get_db
from ..auth import get_current_user

router = APIRouter(prefix="/security", tags=["security"])


class CodeIn(BaseModel):
    code: str = ""


class CredentialIn(BaseModel):
    credential: dict
    name: str = ""


@router.get("/status")
def my_security(db: Session = Depends(get_db),
                user: models.User = Depends(get_current_user)):
    return security.status(db, user)


@router.post("/totp/setup")
def totp_setup(db: Session = Depends(get_db),
               user: models.User = Depends(get_current_user)):
    return security.totp_setup(db, user)


@router.post("/totp/verify")
def totp_verify(data: CodeIn, db: Session = Depends(get_db),
                user: models.User = Depends(get_current_user)):
    res = security.totp_verify_and_enable(db, user, data.code)
    audit.log(db, user, "mfa_enable", f"{user.email} enabled authenticator MFA")
    db.commit()
    return res


@router.post("/totp/disable")
def totp_disable(data: CodeIn, db: Session = Depends(get_db),
                 user: models.User = Depends(get_current_user)):
    # Disabling MFA is itself sensitive — require a valid current factor.
    if not security.verify_factor(db, user, data.code):
        raise HTTPException(401, "Enter a valid authenticator or recovery code to disable.")
    res = security.disable_totp(db, user)
    audit.log(db, user, "mfa_disable", f"{user.email} disabled authenticator MFA")
    db.commit()
    return res


@router.post("/recovery/regenerate")
def recovery_regen(data: CodeIn, db: Session = Depends(get_db),
                   user: models.User = Depends(get_current_user)):
    if not security.verify_factor(db, user, data.code):
        raise HTTPException(401, "Enter a valid authenticator or recovery code first.")
    return security.regenerate_recovery(db, user)


@router.post("/stepup")
def stepup(data: CodeIn, db: Session = Depends(get_db),
           user: models.User = Depends(get_current_user)):
    """Re-verify with an authenticator/recovery code to unlock sensitive actions
    for a short window. (A passkey tap via /passkey/stepup does the same.)"""
    if not security.verify_factor(db, user, data.code):
        raise HTTPException(401, "Verification failed.")
    security.mark_stepup(db, user)
    return {"ok": True, "valid_seconds": security.STEPUP_WINDOW_SECONDS}


# --- Passkeys / WebAuthn (Phase 2b) --------------------------------------

@router.post("/passkey/register/begin")
def passkey_register_begin(db: Session = Depends(get_db),
                           user: models.User = Depends(get_current_user)):
    return webauthn_svc.register_begin(db, user)


@router.post("/passkey/register/finish")
def passkey_register_finish(data: CredentialIn, db: Session = Depends(get_db),
                            user: models.User = Depends(get_current_user)):
    res = webauthn_svc.register_finish(db, user, data.credential, data.name)
    audit.log(db, user, "passkey_add", f"{user.email} registered a passkey")
    db.commit()
    return res


@router.post("/passkey/stepup/begin")
def passkey_stepup_begin(db: Session = Depends(get_db),
                         user: models.User = Depends(get_current_user)):
    return webauthn_svc.auth_begin(db, user)


@router.post("/passkey/stepup/finish")
def passkey_stepup_finish(data: CredentialIn, db: Session = Depends(get_db),
                          user: models.User = Depends(get_current_user)):
    webauthn_svc.auth_verify(db, user, data.credential)  # marks step-up
    return {"ok": True}
