"""Spotify playback via OAuth2. Requires Spotify Premium and an active device.
Supports precise track+artist search and playing a playlist from the user's library."""
import os
import base64
import datetime
from urllib.parse import urlencode
import httpx
from . import models

AUTH_URL = "https://accounts.spotify.com/authorize"
TOKEN_URL = "https://accounts.spotify.com/api/token"
API = "https://api.spotify.com/v1"
SCOPE = "user-modify-playback-state user-read-playback-state playlist-read-private"


def _cfg():
    return (os.getenv("SPOTIFY_CLIENT_ID"), os.getenv("SPOTIFY_CLIENT_SECRET"),
            os.getenv("SPOTIFY_REDIRECT", "http://127.0.0.1:8000/oauth/spotify/callback"))


def is_configured():
    cid, sec, _ = _cfg()
    return bool(cid and sec)


def is_connected(db, user_id):
    return db.get(models.SpotifyToken, user_id) is not None


def auth_url(state):
    cid, _, redirect = _cfg()
    return AUTH_URL + "?" + urlencode({"client_id": cid, "response_type": "code",
                                       "redirect_uri": redirect, "scope": SCOPE, "state": state})


def _basic():
    cid, sec, _ = _cfg()
    return base64.b64encode(f"{cid}:{sec}".encode()).decode()


# ---- App-level search (Client Credentials): no user login, no redirect URI ----
_app_tok = {"token": None, "exp": datetime.datetime.min}


async def _app_token():
    """Cached app-only access token (client-credentials). Lets us search Spotify's
    catalog without any user login."""
    now = datetime.datetime.utcnow()
    if _app_tok["token"] and _app_tok["exp"] > now:
        return _app_tok["token"]
    if not is_configured():
        return None
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.post(TOKEN_URL, headers={"Authorization": f"Basic {_basic()}"},
                         data={"grant_type": "client_credentials"})
    j = r.json()
    tok = j.get("access_token")
    if tok:
        _app_tok["token"] = tok
        _app_tok["exp"] = now + datetime.timedelta(seconds=int(j.get("expires_in", 3600)) - 60)
    return tok


async def search_track(query: str):
    """Find the best-matching track and return its name, artist, and Spotify link
    (and a 30s preview if Spotify still provides one). No user login required."""
    tok = await _app_token()
    if not tok:
        return None
    try:
        async with httpx.AsyncClient(timeout=15) as c:
            r = await c.get(f"{API}/search", headers={"Authorization": f"Bearer {tok}"},
                            params={"q": query, "type": "track", "limit": 1})
        items = (r.json().get("tracks", {}) or {}).get("items", [])
        if not items:
            return None
        t = items[0]
        return {"track": t.get("name"),
                "artist": (t.get("artists") or [{}])[0].get("name"),
                "spotify_url": (t.get("external_urls") or {}).get("spotify"),
                "preview_url": t.get("preview_url")}
    except Exception:
        return None


async def exchange_code(code):
    _, _, redirect = _cfg()
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.post(TOKEN_URL, headers={"Authorization": f"Basic {_basic()}"},
                         data={"grant_type": "authorization_code", "code": code, "redirect_uri": redirect})
        return r.json()


def save_token(db, user_id, tok):
    row = db.get(models.SpotifyToken, user_id) or models.SpotifyToken(user_id=user_id)
    row.access_token = tok.get("access_token")
    if tok.get("refresh_token"):
        row.refresh_token = tok.get("refresh_token")
    row.expiry = datetime.datetime.utcnow() + datetime.timedelta(seconds=int(tok.get("expires_in", 3600)))
    db.add(row); db.commit()


async def _access(db, user_id):
    row = db.get(models.SpotifyToken, user_id)
    if not row:
        return None
    if row.expiry and row.expiry > datetime.datetime.utcnow() + datetime.timedelta(seconds=30):
        return row.access_token
    if not row.refresh_token:
        return row.access_token
    async with httpx.AsyncClient(timeout=15) as c:
        tok = (await c.post(TOKEN_URL, headers={"Authorization": f"Basic {_basic()}"},
                            data={"grant_type": "refresh_token", "refresh_token": row.refresh_token})).json()
    if tok.get("access_token"):
        row.access_token = tok["access_token"]
        row.expiry = datetime.datetime.utcnow() + datetime.timedelta(seconds=int(tok.get("expires_in", 3600)))
        if tok.get("refresh_token"):
            row.refresh_token = tok["refresh_token"]
        db.commit()
        return row.access_token
    return None


async def _device(c, headers):
    dr = await c.get(f"{API}/me/player/devices", headers=headers)
    devices = dr.json().get("devices", [])
    if not devices:
        return {"error": "No active Spotify device. Open Spotify on your phone or computer "
                         "(play anything once), then ask again."}
    d = next((x for x in devices if x.get("is_active")), devices[0])
    return {"id": d["id"], "name": d.get("name")}


async def play(db, user, query, artist=None):
    access = await _access(db, user.id)
    if not access:
        return {"error": "Spotify isn't connected."}
    headers = {"Authorization": f"Bearer {access}"}
    artist = (artist or "").strip()
    q = f'track:"{query}" artist:"{artist}"' if artist else (query or "").strip()
    try:
        async with httpx.AsyncClient(timeout=15) as c:
            async def search(query_str):
                r = await c.get(f"{API}/search", headers=headers, params={"q": query_str, "type": "track", "limit": 3})
                return r.json().get("tracks", {}).get("items", [])
            items = await search(q)
            if not items and artist:  # precise filter found nothing — try a loose query
                items = await search(f"{query} {artist}")
            if not items:
                items = await search(query)
            if not items:
                return {"error": f"Couldn't find '{query}'{' by ' + artist if artist else ''} on Spotify."}
            t = items[0]
            uri, name = t["uri"], t["name"]
            art = ", ".join(a["name"] for a in t.get("artists", []))
            dev = await _device(c, headers)
            if "error" in dev:
                return dev
            pr = await c.put(f"{API}/me/player/play", headers=headers, params={"device_id": dev["id"]}, json={"uris": [uri]})
            if pr.status_code == 403:
                return {"error": "Spotify says this account can't control playback (Premium required)."}
            if pr.status_code >= 300:
                return {"error": f"Spotify play failed ({pr.status_code})."}
            return {"playing": name, "artist": art, "device": dev["name"]}
    except Exception as e:
        return {"error": f"Spotify error: {e}"}


async def play_playlist(db, user, name):
    access = await _access(db, user.id)
    if not access:
        return {"error": "Spotify isn't connected."}
    headers = {"Authorization": f"Bearer {access}"}
    name = (name or "").strip()
    try:
        async with httpx.AsyncClient(timeout=15) as c:
            uri, pname = None, None
            # 1) prefer the user's OWN playlists
            mine = (await c.get(f"{API}/me/playlists", headers=headers, params={"limit": 50})).json().get("items", [])
            for pl in mine:
                if pl and name.lower() in (pl.get("name") or "").lower():
                    uri, pname = pl["uri"], pl["name"]; break
            # 2) fall back to public search
            if not uri:
                res = (await c.get(f"{API}/search", headers=headers, params={"q": name, "type": "playlist", "limit": 1})).json()
                pls = res.get("playlists", {}).get("items", [])
                if pls:
                    uri, pname = pls[0]["uri"], pls[0]["name"]
            if not uri:
                return {"error": f"No playlist matching '{name}'."}
            dev = await _device(c, headers)
            if "error" in dev:
                return dev
            await c.put(f"{API}/me/player/shuffle", headers=headers, params={"state": "true", "device_id": dev["id"]})
            pr = await c.put(f"{API}/me/player/play", headers=headers, params={"device_id": dev["id"]}, json={"context_uri": uri})
            if pr.status_code == 403:
                return {"error": "Spotify playback requires Premium."}
            if pr.status_code >= 300:
                return {"error": f"Spotify play failed ({pr.status_code})."}
            return {"playing_playlist": pname, "device": dev["name"]}
    except Exception as e:
        return {"error": f"Spotify error: {e}"}


async def control(db, user, action, volume_percent=None):
    access = await _access(db, user.id)
    if not access:
        return {"error": "Spotify isn't connected."}
    headers = {"Authorization": f"Bearer {access}"}
    action = (action or "").lower()
    try:
        async with httpx.AsyncClient(timeout=15) as c:
            if action == "pause":
                r = await c.put(f"{API}/me/player/pause", headers=headers)
            elif action in ("resume", "play", "unpause"):
                r = await c.put(f"{API}/me/player/play", headers=headers)
            elif action in ("next", "skip"):
                r = await c.post(f"{API}/me/player/next", headers=headers)
            elif action in ("previous", "prev", "back", "last"):
                r = await c.post(f"{API}/me/player/previous", headers=headers)
            elif action in ("volume", "set_volume"):
                v = max(0, min(100, int(volume_percent if volume_percent is not None else 50)))
                r = await c.put(f"{API}/me/player/volume", headers=headers, params={"volume_percent": v})
                if r.status_code < 300:
                    return {"done": "volume", "volume": v}
            else:
                return {"error": f"unknown action '{action}'"}
            if r.status_code == 403:
                return {"error": "Premium is required for playback control."}
            if r.status_code == 404:
                return {"error": "No active Spotify device. Open Spotify and play something first."}
            if r.status_code >= 300:
                return {"error": f"Spotify control failed ({r.status_code})."}
            return {"done": action}
    except Exception as e:
        return {"error": f"Spotify error: {e}"}
