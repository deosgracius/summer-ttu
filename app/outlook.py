"""Outlook / Microsoft 365 mail via Microsoft Graph (OAuth2). Skips no-reply senders."""
import os
import datetime
from urllib.parse import urlencode
import httpx
from . import models

GRAPH = "https://graph.microsoft.com/v1.0"
SCOPE = "offline_access User.Read Mail.ReadWrite Mail.Send"
NOREPLY = ("noreply", "no-reply", "donotreply", "do-not-reply", "no_reply", "do_not_reply")


def _cfg():
    return (os.getenv("OUTLOOK_CLIENT_ID"), os.getenv("OUTLOOK_CLIENT_SECRET"),
            os.getenv("OUTLOOK_REDIRECT", "http://localhost:8000/oauth/outlook/callback"),
            os.getenv("OUTLOOK_TENANT", "common"))


def is_configured():
    cid, sec, _, _ = _cfg()
    return bool(cid and sec)


def is_connected(db, user_id):
    return db.get(models.OutlookToken, user_id) is not None


def _base(tenant):
    return f"https://login.microsoftonline.com/{tenant}/oauth2/v2.0"


def auth_url(state):
    cid, _, redirect, tenant = _cfg()
    return _base(tenant) + "/authorize?" + urlencode({
        "client_id": cid, "response_type": "code", "redirect_uri": redirect,
        "response_mode": "query", "scope": SCOPE, "state": state})


def _is_noreply(a):
    a = (a or "").lower()
    return any(k in a for k in NOREPLY)


async def exchange_code(code):
    cid, sec, redirect, tenant = _cfg()
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.post(_base(tenant) + "/token", data={
            "client_id": cid, "client_secret": sec, "code": code, "redirect_uri": redirect,
            "grant_type": "authorization_code", "scope": SCOPE})
        return r.json()


def save_token(db, uid, tok):
    row = db.get(models.OutlookToken, uid) or models.OutlookToken(user_id=uid)
    row.access_token = tok.get("access_token")
    if tok.get("refresh_token"):
        row.refresh_token = tok.get("refresh_token")
    row.expiry = datetime.datetime.utcnow() + datetime.timedelta(seconds=int(tok.get("expires_in", 3600)))
    db.add(row); db.commit()


async def _access(db, uid):
    row = db.get(models.OutlookToken, uid)
    if not row:
        return None
    if row.expiry and row.expiry > datetime.datetime.utcnow() + datetime.timedelta(seconds=30):
        return row.access_token
    if not row.refresh_token:
        return row.access_token
    cid, sec, redirect, tenant = _cfg()
    async with httpx.AsyncClient(timeout=15) as c:
        tok = (await c.post(_base(tenant) + "/token", data={
            "client_id": cid, "client_secret": sec, "refresh_token": row.refresh_token,
            "grant_type": "refresh_token", "scope": SCOPE})).json()
    if tok.get("access_token"):
        row.access_token = tok["access_token"]
        row.expiry = datetime.datetime.utcnow() + datetime.timedelta(seconds=int(tok.get("expires_in", 3600)))
        if tok.get("refresh_token"):
            row.refresh_token = tok["refresh_token"]
        db.commit()
        return row.access_token
    return None


async def list_messages(db, user, limit=8):
    access = await _access(db, user.id)
    if not access:
        return {"error": "Outlook isn't connected."}
    h = {"Authorization": f"Bearer {access}"}
    try:
        async with httpx.AsyncClient(timeout=20) as c:
            r = await c.get(f"{GRAPH}/me/messages", headers=h, params={
                "$top": limit * 2, "$select": "id,subject,from,bodyPreview", "$orderby": "receivedDateTime desc"})
            if r.status_code >= 300:
                return {"error": f"Outlook read failed ({r.status_code})."}
            out = []
            for m in r.json().get("value", []):
                frm = ((m.get("from") or {}).get("emailAddress") or {}).get("address", "")
                if _is_noreply(frm):
                    continue
                out.append({"id": m["id"], "from": frm, "subject": m.get("subject", "(no subject)"),
                            "snippet": (m.get("bodyPreview", "") or "")[:160]})
                if len(out) >= limit:
                    break
            return out
    except Exception as e:
        return {"error": f"Outlook error: {e}"}


async def send_reply(db, user, message_id, body):
    access = await _access(db, user.id)
    if not access:
        return {"error": "Outlook isn't connected."}
    h = {"Authorization": f"Bearer {access}"}
    try:
        async with httpx.AsyncClient(timeout=20) as c:
            mr = await c.get(f"{GRAPH}/me/messages/{message_id}", headers=h, params={"$select": "from,subject"})
            if mr.status_code < 300:
                frm = ((mr.json().get("from") or {}).get("emailAddress") or {}).get("address", "")
                if _is_noreply(frm):
                    return {"error": "That sender is a no-reply address \u2014 not replying."}
            sr = await c.post(f"{GRAPH}/me/messages/{message_id}/reply", headers=h, json={"comment": body})
            if sr.status_code >= 300:
                return {"error": f"Reply failed ({sr.status_code})."}
            return {"sent": True}
    except Exception as e:
        return {"error": f"Outlook error: {e}"}


async def send_new(db, user, to, subject, body):
    access = await _access(db, user.id)
    if not access:
        return {"error": "Outlook isn't connected."}
    if _is_noreply(to):
        return {"error": "That looks like a no-reply address."}
    h = {"Authorization": f"Bearer {access}"}
    payload = {"message": {"subject": subject, "body": {"contentType": "Text", "content": body},
                           "toRecipients": [{"emailAddress": {"address": to}}]}, "saveToSentItems": True}
    try:
        async with httpx.AsyncClient(timeout=20) as c:
            sr = await c.post(f"{GRAPH}/me/sendMail", headers=h, json=payload)
            if sr.status_code >= 300:
                return {"error": f"Send failed ({sr.status_code})."}
            return {"sent": True, "to": to}
    except Exception as e:
        return {"error": f"Outlook error: {e}"}


async def trash(db, user, message_id):
    access = await _access(db, user.id)
    if not access:
        return {"error": "Outlook isn't connected."}
    h = {"Authorization": f"Bearer {access}"}
    try:
        async with httpx.AsyncClient(timeout=20) as c:
            r = await c.delete(f"{GRAPH}/me/messages/{message_id}", headers=h)
            if r.status_code >= 300:
                return {"error": f"Delete failed ({r.status_code}). Reconnect Outlook to grant Mail.ReadWrite."}
            return {"trashed": True}
    except Exception as e:
        return {"error": f"Outlook error: {e}"}
