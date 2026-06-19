"""Fetch a web page and return readable text (for summarizing articles/news/pages).

SSRF-guarded: only public http(s) hosts are allowed. Internal/loopback/private/
link-local targets (e.g. localhost, 10.x, 192.168.x, 169.254.169.254 cloud
metadata) are blocked, and every redirect hop is re-validated."""
import re
import socket
import ipaddress
from urllib.parse import urlparse
import httpx

MAX_REDIRECTS = 4


def _host_is_public(host: str) -> bool:
    """Resolve the host and reject if ANY resolved IP is non-public."""
    try:
        infos = socket.getaddrinfo(host, None)
    except Exception:
        return False
    if not infos:
        return False
    for info in infos:
        try:
            addr = ipaddress.ip_address(info[4][0])
        except ValueError:
            return False
        if (addr.is_private or addr.is_loopback or addr.is_link_local
                or addr.is_reserved or addr.is_multicast or addr.is_unspecified):
            return False
    return True


def _is_allowed(url: str) -> bool:
    p = urlparse(url)
    return p.scheme in ("http", "https") and bool(p.hostname) and _host_is_public(p.hostname)


async def fetch_page(url):
    url = (url or "").strip()
    if not url:
        return {"error": "No URL provided."}
    if not url.startswith("http"):
        url = "https://" + url
    try:
        # Follow redirects manually so each hop is SSRF-checked (a public URL can
        # otherwise 30x-redirect to an internal one).
        async with httpx.AsyncClient(timeout=20, follow_redirects=False,
                                     headers={"User-Agent": "Mozilla/5.0 (Summer assistant)"}) as c:
            r = None
            for _ in range(MAX_REDIRECTS):
                if not _is_allowed(url):
                    return {"error": "That URL isn't allowed (only public web addresses can be fetched)."}
                r = await c.get(url)
                if r.is_redirect and r.headers.get("location"):
                    url = str(r.next_request.url) if r.next_request else r.headers["location"]
                    continue
                break
            if r is None:
                return {"error": "Too many redirects."}
            if r.status_code >= 400:
                return {"error": f"Couldn't load the page ({r.status_code})."}
            html = r.text
            html = re.sub(r"<script.*?</script>", " ", html, flags=re.S | re.I)
            html = re.sub(r"<style.*?</style>", " ", html, flags=re.S | re.I)
            text = re.sub(r"<[^>]+>", " ", html)
            text = re.sub(r"\s+", " ", text).strip()
            return {"url": str(r.url), "text": text[:6000]}
    except Exception as e:
        return {"error": f"Fetch error: {e}"}
