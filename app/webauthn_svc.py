"""WebAuthn passkeys (Phase 2b) — the third factor.

Registration and assertion ceremonies for platform authenticators (Windows
Hello, Touch ID). An assertion serves two roles: the 3rd step of login, and the
step-up "tap" required to approve a change.

RP id / origin are environment-specific. Defaults target local dev (Vite on
:5173). In production set WEBAUTHN_RP_ID to your domain and WEBAUTHN_ORIGIN to
the https origin — and remember WebAuthn requires HTTPS off localhost.
"""
import os
import json
from fastapi import HTTPException
from webauthn import (generate_registration_options, verify_registration_response,
                      generate_authentication_options, verify_authentication_response,
                      options_to_json)
from webauthn.helpers import bytes_to_base64url, base64url_to_bytes
from webauthn.helpers.structs import (AuthenticatorSelectionCriteria, ResidentKeyRequirement,
                                      UserVerificationRequirement, PublicKeyCredentialDescriptor)
from . import models, security

RP_ID = os.getenv("WEBAUTHN_RP_ID", "localhost")
RP_NAME = os.getenv("MFA_ISSUER", "Summer (TTU)")
ORIGIN = [o.strip() for o in os.getenv(
    "WEBAUTHN_ORIGIN", "http://localhost:5173,http://localhost:8000").split(",") if o.strip()]


def _creds(db, user):
    return db.query(models.WebAuthnCredential).filter_by(user_id=user.id).all()


def _descriptors(db, user):
    return [PublicKeyCredentialDescriptor(id=base64url_to_bytes(c.credential_id))
            for c in _creds(db, user)]


def register_begin(db, user):
    sec = security._ensure(db, user)
    opts = generate_registration_options(
        rp_id=RP_ID, rp_name=RP_NAME, user_name=user.email,
        user_id=str(user.id).encode(), user_display_name=user.email,
        exclude_credentials=_descriptors(db, user),
        authenticator_selection=AuthenticatorSelectionCriteria(
            resident_key=ResidentKeyRequirement.PREFERRED,
            user_verification=UserVerificationRequirement.PREFERRED),
    )
    sec.current_challenge = bytes_to_base64url(opts.challenge)
    db.commit()
    return json.loads(options_to_json(opts))


def register_finish(db, user, credential, name=""):
    sec = security.get_security(db, user)
    if not sec or not sec.current_challenge:
        raise HTTPException(400, "Start passkey registration first.")
    try:
        v = verify_registration_response(
            credential=credential,
            expected_challenge=base64url_to_bytes(sec.current_challenge),
            expected_rp_id=RP_ID, expected_origin=ORIGIN)
    except Exception as e:
        raise HTTPException(400, f"Passkey registration failed: {e}")
    db.add(models.WebAuthnCredential(
        user_id=user.id, credential_id=bytes_to_base64url(v.credential_id),
        public_key=bytes_to_base64url(v.credential_public_key),
        sign_count=v.sign_count, name=name or "passkey"))
    sec.current_challenge = None
    db.commit()
    return {"registered": True}


def auth_begin(db, user):
    """Generate an assertion challenge (used for login 3rd factor and step-up)."""
    creds = _descriptors(db, user)
    if not creds:
        raise HTTPException(400, "No passkey registered.")
    sec = security._ensure(db, user)
    opts = generate_authentication_options(
        rp_id=RP_ID, allow_credentials=creds,
        user_verification=UserVerificationRequirement.PREFERRED)
    sec.current_challenge = bytes_to_base64url(opts.challenge)
    db.commit()
    return json.loads(options_to_json(opts))


def auth_verify(db, user, credential):
    """Verify an assertion, update the signature counter, and mark a fresh
    step-up. Returns True on success."""
    sec = security.get_security(db, user)
    if not sec or not sec.current_challenge:
        raise HTTPException(400, "No active challenge.")
    cred_id = credential.get("id") if isinstance(credential, dict) else None
    record = db.query(models.WebAuthnCredential).filter_by(
        user_id=user.id, credential_id=cred_id).first()
    if not record:
        raise HTTPException(400, "Unknown passkey.")
    try:
        v = verify_authentication_response(
            credential=credential,
            expected_challenge=base64url_to_bytes(sec.current_challenge),
            expected_rp_id=RP_ID, expected_origin=ORIGIN,
            credential_public_key=base64url_to_bytes(record.public_key),
            credential_current_sign_count=record.sign_count)
    except Exception as e:
        raise HTTPException(400, f"Passkey verification failed: {e}")
    record.sign_count = v.new_sign_count
    sec.current_challenge = None
    security.mark_stepup(db, user)
    db.commit()
    return True
