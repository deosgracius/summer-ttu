"""Fetch a web page and return readable text (for summarizing articles/news/pages).

SSRF-guarded: only public http(s) hosts are allowed. Internal/loopback/private/
link-local targets (e.g. localhost, 10.x, 192.168.x, 169.254.169.254 cloud
metadata) are blocked, and every redirect hop is re-validated."""
import re
import socket
import ipaddress
from urllib.parse import urlparse, quote_plus
import httpx

MAX_REDIRECTS = 4

# Search-result URL templates per source (no API key needed — just opens the
# site's search). DigiKey/Mouser are the electronics-part suppliers an ECE
# department uses; the rest are general/web/shopping.
SEARCH_SOURCES = {
    "google": "https://www.google.com/search?q={q}",
    "wikipedia": "https://en.wikipedia.org/w/index.php?search={q}",
    "amazon": "https://www.amazon.com/s?k={q}",
    "digikey": "https://www.digikey.com/en/products/result?keywords={q}",
    "mouser": "https://www.mouser.com/c/?q={q}",
}


def search_url(query: str, source: str = "google") -> tuple:
    """Return (resolved_source, search_results_url) for the query."""
    src = (source or "google").lower().strip()
    if src not in SEARCH_SOURCES:
        src = "google"
    return src, SEARCH_SOURCES[src].format(q=quote_plus((query or "").strip()))


def _ip_is_public(addr) -> bool:
    """True only for a routable public address (rejects internal/metadata IPs)."""
    return not (addr.is_private or addr.is_loopback or addr.is_link_local
                or addr.is_reserved or addr.is_multicast or addr.is_unspecified)


def _resolve_public(host: str, port=None):
    """Resolve the host ONCE and return the list of resolved IP strings only if
    EVERY one is public; otherwise None (reject).

    The caller must then connect to one of these exact IPs rather than letting
    httpx re-resolve the name. Re-resolution would reopen a DNS-rebinding
    (TOCTOU) window: a short-TTL host controlled by the caller can answer with a
    public IP for this check and a private/metadata IP (127.0.0.1, 10.x,
    169.254.169.254) at connect time. Pinning to a validated IP means the address
    we vetted is the address we connect to."""
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except Exception:
        return None
    if not infos:
        return None
    ips = []
    for info in infos:
        try:
            addr = ipaddress.ip_address(info[4][0])
        except ValueError:
            return None
        if not _ip_is_public(addr):
            return None
        ips.append(info[4][0])
    return ips


def _host_is_public(host: str) -> bool:
    """Resolve the host and reject if ANY resolved IP is non-public."""
    return _resolve_public(host) is not None


def _is_allowed(url: str) -> bool:
    p = urlparse(url)
    return p.scheme in ("http", "https") and bool(p.hostname) and _host_is_public(p.hostname)


async def _pinned_get(c, logical: "httpx.URL"):
    """GET the logical URL but pin the TCP connection to a freshly-validated IP.

    Returns (response, error_message). On success error_message is None; on a
    disallowed/unresolvable host response is None and error_message is set.
    We connect to the IP literal while keeping the original Host header and (for
    https) the SNI/cert hostname, so TLS still verifies against the real name and
    no second DNS lookup can slip in a different address."""
    scheme, host = logical.scheme, logical.host
    if scheme not in ("http", "https") or not host:
        return None, "That URL isn't allowed (only public web addresses can be fetched)."
    default_port = 443 if scheme == "https" else 80
    port = logical.port or default_port
    ips = _resolve_public(host, port)
    if not ips:
        return None, "That URL isn't allowed (only public web addresses can be fetched)."
    target = logical.copy_with(host=ips[0])  # keeps original path/query/port, swaps host to the vetted IP
    host_header = host if (logical.port in (None, default_port)) else f"{host}:{logical.port}"
    extensions = {"sni_hostname": host} if scheme == "https" else {}
    r = await c.get(target, headers={"Host": host_header}, extensions=extensions)
    return r, None


async def fetch_page(url):
    url = (url or "").strip()
    if not url:
        return {"error": "No URL provided."}
    if not url.startswith("http"):
        url = "https://" + url
    try:
        # Follow redirects manually so each hop is SSRF-checked AND pinned to the
        # IP we validated (a public URL can otherwise 30x-redirect to an internal
        # one, or rebind DNS between the check and the connect).
        async with httpx.AsyncClient(timeout=20, follow_redirects=False,
                                     headers={"User-Agent": "Mozilla/5.0 (Summer assistant)"}) as c:
            r = None
            logical = httpx.URL(url)
            for _ in range(MAX_REDIRECTS):
                r, err = await _pinned_get(c, logical)
                if err:
                    return {"error": err}
                if r.is_redirect and r.headers.get("location"):
                    # Resolve the redirect against the real (logical) URL, not the
                    # pinned IP URL, then re-validate + re-pin on the next hop.
                    logical = logical.join(r.headers["location"])
                    url = str(logical)
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
            return {"url": str(logical), "text": text[:6000]}
    except Exception as e:
        return {"error": f"Fetch error: {e}"}
