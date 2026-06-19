import datetime
import jwt
from fastapi import APIRouter, Depends, Query, HTTPException
from fastapi.responses import RedirectResponse, HTMLResponse
from sqlalchemy.orm import Session
from .. import models, auth
from ..database import get_db
from ..spotify import is_configured, is_connected, auth_url, exchange_code, save_token

router = APIRouter(prefix="/oauth/spotify", tags=["spotify"])


def _popup_done(status: str) -> HTMLResponse:
    """The Connect flow runs in a small popup window. When Spotify sends the user
    back here, tell the opener tab how it went and close the popup — so the user
    lands back in the React app, not on a dead /ui/ page."""
    ok = status == "connected"
    title = "Spotify connected" if ok else "Spotify connection failed"
    msg = ("You're all set — Summer can control your Spotify now. "
           "You can close this window.") if ok else \
          ("Something went wrong connecting Spotify. You can close this window and try again.")
    return HTMLResponse(f"""<!doctype html><meta charset="utf-8"><title>{title}</title>
<body style="font-family:system-ui;background:#0b1020;color:#e5e7eb;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center;max-width:22rem;padding:1.5rem">
  <div style="font-size:2.5rem">{'✅' if ok else '⚠️'}</div>
  <h2 style="margin:.5rem 0">{title}</h2>
  <p style="color:#9ca3af">{msg}</p>
</div>
<script>
  try {{ window.opener && window.opener.postMessage({{source:"summer-spotify",status:"{status}"}}, "*"); }} catch (e) {{}}
  setTimeout(function(){{ window.close(); }}, 1200);
</script>
</body>""")


@router.get("/status")
def status(db: Session = Depends(get_db), user: models.User = Depends(auth.get_current_user)):
    return {"configured": is_configured(), "connected": is_connected(db, user.id)}


@router.post("/disconnect")
def disconnect(db: Session = Depends(get_db), user: models.User = Depends(auth.get_current_user)):
    row = db.get(models.SpotifyToken, user.id)
    if row:
        db.delete(row); db.commit()
    return {"disconnected": True}


@router.get("/start")
def start(token: str = Query(...)):
    if not is_configured():
        raise HTTPException(400, "Spotify OAuth not configured (set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET).")
    try:
        uid = int(jwt.decode(token, auth.SECRET_KEY, algorithms=[auth.ALGORITHM])["sub"])
    except Exception:
        raise HTTPException(401, "Invalid token")
    state = jwt.encode({"uid": uid, "p": "spotify",
                        "exp": datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=10)},
                       auth.SECRET_KEY, algorithm=auth.ALGORITHM)
    return RedirectResponse(auth_url(state))


@router.get("/callback")
async def callback(code: str = Query(None), state: str = Query(None), error: str = Query(None),
                   db: Session = Depends(get_db)):
    if error or not code or not state:
        return _popup_done("error")
    try:
        uid = int(jwt.decode(state, auth.SECRET_KEY, algorithms=[auth.ALGORITHM])["uid"])
    except Exception:
        return _popup_done("error")
    tok = await exchange_code(code)
    if not tok.get("access_token"):
        return _popup_done("error")
    save_token(db, uid, tok)
    return _popup_done("connected")
