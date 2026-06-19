import datetime
import jwt
from fastapi import APIRouter, Depends, Query, HTTPException
from fastapi.responses import RedirectResponse
from sqlalchemy.orm import Session
from .. import models, auth
from ..database import get_db
from ..google_cal import is_configured, is_connected, auth_url, exchange_code, save_token

router = APIRouter(prefix="/oauth/google", tags=["oauth"])


@router.get("/status")
def status(db: Session = Depends(get_db), user: models.User = Depends(auth.get_current_user)):
    return {"configured": is_configured(), "connected": is_connected(db, user.id)}


@router.post("/disconnect")
def disconnect(db: Session = Depends(get_db), user: models.User = Depends(auth.get_current_user)):
    row = db.get(models.GoogleToken, user.id)
    if row:
        db.delete(row)
        db.commit()
    return {"disconnected": True}


@router.get("/start")
def start(token: str = Query(...), db: Session = Depends(get_db)):
    if not is_configured():
        raise HTTPException(400, "Google OAuth not configured (set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET).")
    try:
        uid = int(jwt.decode(token, auth.SECRET_KEY, algorithms=[auth.ALGORITHM])["sub"])
    except Exception:
        raise HTTPException(401, "Invalid token")
    state = jwt.encode({"uid": uid, "p": "gcal",
                        "exp": datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=10)},
                       auth.SECRET_KEY, algorithm=auth.ALGORITHM)
    return RedirectResponse(auth_url(state))


@router.get("/callback")
async def callback(code: str = Query(None), state: str = Query(None), error: str = Query(None),
                   db: Session = Depends(get_db)):
    if error or not code or not state:
        return RedirectResponse("/ui/?gcal=error")
    try:
        uid = int(jwt.decode(state, auth.SECRET_KEY, algorithms=[auth.ALGORITHM])["uid"])
    except Exception:
        return RedirectResponse("/ui/?gcal=error")
    tok = await exchange_code(code)
    if not tok.get("access_token"):
        return RedirectResponse("/ui/?gcal=error")
    save_token(db, uid, tok)
    return RedirectResponse("/ui/?gcal=connected")
