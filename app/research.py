"""Keyless research skill: pulls the most relevant Wikipedia articles for a query
and returns their intros, so Claude can synthesize a thorough, intelligent answer
(with sources). For general knowledge / "teach me about X" / "research Y" requests.
Live/real-time info (scores, breaking news) uses dedicated tools instead."""
import httpx

WIKI = "https://en.wikipedia.org/w/api.php"
# Wikimedia blocks generic user-agents (403); their policy requires a descriptive
# UA with a contact.
UA = "Summer-TTU/1.0 (https://summer-ttu.fly.dev; deosgracius17@gmail.com)"


async def web_research(query: str) -> dict:
    q = (query or "").strip()
    if not q:
        return {"error": "What should I research?"}
    try:
        async with httpx.AsyncClient(timeout=12, headers={"User-Agent": UA}) as c:
            r = await c.get(WIKI, params={
                "action": "query", "prop": "extracts", "exintro": 1, "explaintext": 1,
                "redirects": 1, "generator": "search", "gsrsearch": q,
                "gsrlimit": 3, "format": "json"})
            pages = (r.json().get("query", {}) or {}).get("pages", {}) or {}
            results = []
            # Keep Wikipedia's own search ranking (the 'index' field).
            for page in sorted(pages.values(), key=lambda p: p.get("index", 99)):
                extract = (page.get("extract") or "").strip()
                if not extract:
                    continue
                title = page.get("title", "")
                results.append({
                    "title": title,
                    "summary": extract[:1800],
                    "url": "https://en.wikipedia.org/wiki/" + title.replace(" ", "_"),
                })
            if not results:
                return {"error": f"No results found for '{q}'."}
            return {"source": "Wikipedia", "results": results[:3]}
    except Exception as e:
        return {"error": f"Research failed: {e}"}
