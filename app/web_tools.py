"""Fetch a web page and return readable text (for summarizing articles/news/pages)."""
import re
import httpx


async def fetch_page(url):
    url = (url or "").strip()
    if not url:
        return {"error": "No URL provided."}
    if not url.startswith("http"):
        url = "https://" + url
    try:
        async with httpx.AsyncClient(timeout=20, follow_redirects=True,
                                     headers={"User-Agent": "Mozilla/5.0 (Summer assistant)"}) as c:
            r = await c.get(url)
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
