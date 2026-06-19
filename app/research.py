"""A simple, keyless research tool. Looks a topic up on Wikipedia and returns a
short summary. Real-time info (live scores, breaking news) would use a dedicated
API instead; this is the general 'look something up / teach me about X' skill."""
import httpx


async def web_research(query: str) -> dict:
    try:
        async with httpx.AsyncClient(timeout=10, headers={"User-Agent": "Summer/0.1"}) as c:
            r = await c.get("https://en.wikipedia.org/w/api.php", params={
                "action": "query", "prop": "extracts", "exintro": 1, "explaintext": 1,
                "redirects": 1, "generator": "search", "gsrsearch": query,
                "gsrlimit": 1, "format": "json"})
            pages = r.json().get("query", {}).get("pages", {})
            if not pages:
                return {"error": f"No results found for '{query}'."}
            page = next(iter(pages.values()))
            extract = (page.get("extract") or "").strip()
            if not extract:
                return {"error": f"No summary available for '{query}'."}
            return {"title": page.get("title"), "summary": extract[:900], "source": "Wikipedia"}
    except Exception as e:
        return {"error": f"Research failed: {e}"}
