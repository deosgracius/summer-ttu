import os
import datetime
import jwt
import bcrypt
from fastapi import Depends, HTTPException
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.orm import Session
from .database import get_db
from . import models

SECRET_KEY = os.getenv("SECRET_KEY", "dev-secret-change-me")
ALGORITHM = "HS256"
EXPIRE_MIN = int(os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", "60"))
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="auth/login")


def hash_password(p: str) -> str:
    return bcrypt.hashpw(p.encode(), bcrypt.gensalt()).decode()


def verify_password(p: str, h: str) -> bool:
    return bcrypt.checkpw(p.encode(), h.encode())


def create_token(sub: int) -> str:
    exp = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=EXPIRE_MIN)
    return jwt.encode({"sub": str(sub), "exp": exp}, SECRET_KEY, algorithm=ALGORITHM)


def get_current_user(token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)) -> models.User:
    cred_exc = HTTPException(status_code=401, detail="Invalid credentials",
                            headers={"WWW-Authenticate": "Bearer"})
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        uid = int(payload.get("sub"))
    except Exception:
        raise cred_exc
    user = db.get(models.User, uid)
    if not user:
        raise cred_exc
    # Track the central admin's activity so deputy delegation knows when they're away.
    from . import delegation
    delegation.record_central_seen(db, user)
    return user


# Role hierarchy for the delegation model. Higher rank = more authority.
# central_admin grants admin/user prerogatives; admin manages campus data and can
# grant access up to its own level. tutor/officer are contributors who maintain
# only their own availability; customer (student) is the basic end user.
ROLE_RANKS = {"customer": 1, "tutor": 2, "officer": 2, "client": 2,
              "admin": 3, "central_admin": 4}


def rank(role: str) -> int:
    return ROLE_RANKS.get(role, 0)


def require_roles(*roles):
    """Dependency that allows the request only if the user has one of the given
    roles. central_admin inherits every admin-gated endpoint automatically."""
    allowed = set(roles)
    if "admin" in allowed:
        allowed.add("central_admin")

    def dep(user: models.User = Depends(get_current_user)) -> models.User:
        if user.role not in allowed:
            raise HTTPException(status_code=403, detail=f"Requires role: {', '.join(roles)}")
        return user
    return dep


def create_reset_token(sub: int) -> str:
    exp = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=30)
    return jwt.encode({"sub": str(sub), "purpose": "reset", "exp": exp}, SECRET_KEY, algorithm=ALGORITHM)


def verify_reset_token(token: str):
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        if payload.get("purpose") != "reset":
            return None
        return int(payload.get("sub"))
    except Exception:
        return None
