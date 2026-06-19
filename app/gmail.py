"""Gmail read/reply/send, reusing the Google OAuth token. Skips no-reply senders."""
import base64
import httpx
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from email.mime.application import MIMEApplication
from .google_cal import _access, is_connected as _g_connected

GBASE = "https://gmail.googleapis.com/gmail/v1/users/me"
NOREPLY = ("noreply", "no-reply", "donotreply", "do-not-reply", "no_reply", "do_not_reply")


def is_connected(db, user_id):
    return _g_connected(db, user_id)


def _is_noreply(addr):
    a = (addr or "").lower()
    return any(k in a for k in NOREPLY)


async def list_messages(db, user, limit=8):
    access = await _access(db, user.id)
    if not access:
        return {"error": "Google isn't connected."}
    h = {"Authorization": f"Bearer {access}"}
    try:
        async with httpx.AsyncClient(timeout=20) as c:
            r = await c.get(f"{GBASE}/messages", headers=h, params={"maxResults": limit * 2, "q": "in:inbox"})
            if r.status_code >= 300:
                return {"error": f"Gmail read failed ({r.status_code}). Enable the Gmail API and reconnect Google."}
            out = []
            for mref in r.json().get("messages", []):
                mr = await c.get(f"{GBASE}/messages/{mref['id']}", headers=h,
                                 params={"format": "metadata", "metadataHeaders": ["From", "Subject"]})
                if mr.status_code >= 300:
                    continue
                msg = mr.json()
                hs = {x["name"]: x["value"] for x in msg.get("payload", {}).get("headers", [])}
                frm = hs.get("From", "")
                if _is_noreply(frm):
                    continue
                out.append({"id": mref["id"], "threadId": msg.get("threadId"), "from": frm,
                            "subject": hs.get("Subject", "(no subject)"), "snippet": (msg.get("snippet", "") or "")[:160]})
                if len(out) >= limit:
                    break
            return out
    except Exception as e:
        return {"error": f"Gmail error: {e}"}


async def send_reply(db, user, message_id, body):
    access = await _access(db, user.id)
    if not access:
        return {"error": "Google isn't connected."}
    h = {"Authorization": f"Bearer {access}"}
    try:
        async with httpx.AsyncClient(timeout=20) as c:
            mr = await c.get(f"{GBASE}/messages/{message_id}", headers=h,
                             params={"format": "metadata", "metadataHeaders": ["From", "Subject", "Message-ID"]})
            if mr.status_code >= 300:
                return {"error": "Couldn't load the original message."}
            msg = mr.json()
            hs = {x["name"]: x["value"] for x in msg.get("payload", {}).get("headers", [])}
            to = hs.get("From", "")
            if _is_noreply(to):
                return {"error": "That sender is a no-reply address \u2014 not replying."}
            subj = hs.get("Subject", "")
            if not subj.lower().startswith("re:"):
                subj = "Re: " + subj
            mime = MIMEText(body)
            mime["To"] = to
            mime["Subject"] = subj
            mid = hs.get("Message-ID")
            if mid:
                mime["In-Reply-To"] = mid
                mime["References"] = mid
            raw = base64.urlsafe_b64encode(mime.as_bytes()).decode()
            sr = await c.post(f"{GBASE}/messages/send", headers=h, json={"raw": raw, "threadId": msg.get("threadId")})
            if sr.status_code >= 300:
                return {"error": f"Send failed ({sr.status_code})."}
            return {"sent": True, "to": to, "subject": subj}
    except Exception as e:
        return {"error": f"Gmail error: {e}"}


async def send_new(db, user, to, subject, body):
    access = await _access(db, user.id)
    if not access:
        return {"error": "Google isn't connected."}
    if _is_noreply(to):
        return {"error": "That looks like a no-reply address."}
    h = {"Authorization": f"Bearer {access}"}
    mime = MIMEText(body); mime["To"] = to; mime["Subject"] = subject
    raw = base64.urlsafe_b64encode(mime.as_bytes()).decode()
    try:
        async with httpx.AsyncClient(timeout=20) as c:
            sr = await c.post(f"{GBASE}/messages/send", headers=h, json={"raw": raw})
            if sr.status_code >= 300:
                return {"error": f"Send failed ({sr.status_code})."}
            return {"sent": True, "to": to, "subject": subject}
    except Exception as e:
        return {"error": f"Gmail error: {e}"}


async def trash(db, user, message_id):
    access = await _access(db, user.id)
    if not access:
        return {"error": "Google isn't connected."}
    h = {"Authorization": f"Bearer {access}"}
    try:
        async with httpx.AsyncClient(timeout=20) as c:
            r = await c.post(f"{GBASE}/messages/{message_id}/trash", headers=h)
            if r.status_code >= 300:
                return {"error": f"Delete failed ({r.status_code}). Reconnect Google to grant mailbox-modify access."}
            return {"trashed": True, "id": message_id}
    except Exception as e:
        return {"error": f"Gmail error: {e}"}


async def send_with_pdf(db, user, to_list, subject, body, pdf_bytes, filename="receipt.pdf"):
    access = await _access(db, user.id)
    if not access:
        return {"error": "Google isn't connected."}
    to_list = [t for t in to_list if t and not _is_noreply(t)]
    if not to_list:
        return {"error": "no recipients"}
    h = {"Authorization": f"Bearer {access}"}
    msg = MIMEMultipart()
    msg["To"] = ", ".join(to_list); msg["Subject"] = subject
    msg.attach(MIMEText(body))
    part = MIMEApplication(pdf_bytes, _subtype="pdf")
    part.add_header("Content-Disposition", "attachment", filename=filename)
    msg.attach(part)
    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()
    try:
        async with httpx.AsyncClient(timeout=25) as c:
            sr = await c.post(f"{GBASE}/messages/send", headers=h, json={"raw": raw})
            if sr.status_code >= 300:
                return {"error": f"Send failed ({sr.status_code})."}
            return {"sent": True, "to": to_list}
    except Exception as e:
        return {"error": f"Gmail error: {e}"}
