"""SSRF guard for read_webpage / fetch_page (authenticated dashboard tool).

Closes the DNS-rebinding (TOCTOU) hole: the fetcher must resolve a host ONCE,
reject if any resolved address is non-public, and then connect to that exact
vetted IP — never letting httpx re-resolve the name to a private/metadata
address at connect time. Deterministic and network-free (runs in the free CI
gate): DNS is stubbed via socket.getaddrinfo and the HTTP layer is stubbed so no
real connection is ever made."""
import asyncio
import socket

from app import web_tools as w

DISALLOWED = "isn't allowed"


def _addrinfo(*ips):
    """Fake socket.getaddrinfo result for the given IPv4/IPv6 literals."""
    out = []
    for ip in ips:
        fam = socket.AF_INET6 if ":" in ip else socket.AF_INET
        sockaddr = (ip, 0, 0, 0) if fam == socket.AF_INET6 else (ip, 0)
        out.append((fam, socket.SOCK_STREAM, 6, "", sockaddr))
    return out


class _FakeResp:
    def __init__(self, status=200, text="<html>ok</html>"):
        self.status_code = status
        self.text = text
        self.is_redirect = False
        self.headers = {}


def test_direct_internal_literals_are_refused():
    # getaddrinfo on a numeric literal doesn't touch the network, so these
    # exercise the public-IP checks directly (no monkeypatching needed).
    for bad in ["http://127.0.0.1/", "http://169.254.169.254/latest/meta-data/",
                "http://10.0.0.5/", "http://192.168.1.1/", "http://[::1]/",
                "http://0.0.0.0/"]:
        res = asyncio.run(w.fetch_page(bad))
        assert "error" in res and DISALLOWED in res["error"], f"not refused: {bad}"


def test_host_resolving_to_private_ip_is_refused_without_connecting(monkeypatch):
    """A host that resolves to a private IP must be refused, and no HTTP
    connection may be attempted."""
    monkeypatch.setattr(w.socket, "getaddrinfo",
                        lambda *a, **k: _addrinfo("10.0.0.7"))

    async def _boom(*a, **k):  # any connect attempt means the guard failed
        raise AssertionError("fetch_page connected to a non-public host")
    monkeypatch.setattr(w.httpx.AsyncClient, "get", _boom)

    res = asyncio.run(w.fetch_page("http://rebind.attacker.example/"))
    assert "error" in res and DISALLOWED in res["error"]


def test_mixed_public_and_private_answer_is_refused(monkeypatch):
    """If ANY resolved address is non-public the host is rejected — a rebinding
    answer can't smuggle a private IP in alongside a public one."""
    monkeypatch.setattr(w.socket, "getaddrinfo",
                        lambda *a, **k: _addrinfo("93.184.216.34", "127.0.0.1"))
    assert w._resolve_public("rebind.attacker.example") is None
    assert w._host_is_public("rebind.attacker.example") is False


def test_connection_is_pinned_to_validated_ip(monkeypatch):
    """On an allowed host, the TCP target is the vetted IP literal while the Host
    header (and, for https, the SNI hostname) stay the real name — so httpx never
    performs a second, unvetted DNS lookup."""
    monkeypatch.setattr(w.socket, "getaddrinfo",
                        lambda *a, **k: _addrinfo("93.184.216.34"))
    seen = {}

    async def _capture(self, url, headers=None, extensions=None, **k):
        seen["url"] = url
        seen["headers"] = headers or {}
        seen["extensions"] = extensions or {}
        return _FakeResp()
    monkeypatch.setattr(w.httpx.AsyncClient, "get", _capture)

    res = asyncio.run(w.fetch_page("https://news.example.com/article?id=1"))
    assert "text" in res, res
    assert seen["url"].host == "93.184.216.34"                    # connected to vetted IP
    assert seen["headers"].get("Host") == "news.example.com"      # real Host preserved
    assert seen["extensions"].get("sni_hostname") == "news.example.com"  # TLS verifies real name
    assert res["url"] == "https://news.example.com/article?id=1"  # reports real URL, not the IP
