"""Pick a fitting image for an event from its theme/description.

Preference order:
  1. Real stock photo via Pexels   (PEXELS_API_KEY)   -> genuine photography
  2. AI-generated photo via fal FLUX (FAL_KEY)          -> photoreal, adapts to any theme
  3. None -> the UI falls back to a themed gradient

All network calls are best-effort; failures return None and never block event creation.
"""
import os
import re
import httpx

_STOP = {"the","a","an","and","or","of","for","to","in","on","at","with","my","our",
         "event","events","summer","please","this","that","is","are"}


def _key_pexels():
    return os.getenv("PEXELS_API_KEY") or None


def _key_fal():
    return os.getenv("FAL_KEY") or os.getenv("FAL_API_KEY") or None


def enabled() -> bool:
    return bool(_key_pexels() or _key_fal())


def _query(title: str, description: str = "") -> str:
    words = re.findall(r"[A-Za-z]{3,}", f"{title} {description}")
    keep = [w for w in words if w.lower() not in _STOP]
    return " ".join((keep or words)[:5]) or (title or "live event")


async def _pexels(q: str) -> str | None:
    key = _key_pexels()
    if not key:
        return None
    async with httpx.AsyncClient(timeout=20) as c:
        r = await c.get("https://api.pexels.com/v1/search",
                        params={"query": q, "per_page": 1, "orientation": "landscape"},
                        headers={"Authorization": key})
        if r.status_code >= 400:
            return None
        photos = (r.json().get("photos") or [])
        if photos:
            src = photos[0].get("src") or {}
            return src.get("landscape") or src.get("large") or src.get("original")
    return None


async def _fal_flux(title: str, description: str) -> str | None:
    key = _key_fal()
    if not key:
        return None
    prompt = (f"Promotional photo for the event '{title}'. {description}. "
              "Cinematic, photorealistic, vibrant lighting, high detail, no text.")
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=15.0)) as c:
            r = await c.post("https://fal.run/fal-ai/flux/schnell",
                             headers={"Authorization": f"Key {key}", "Content-Type": "application/json"},
                             json={"prompt": prompt[:1500], "image_size": "landscape_16_9", "num_images": 1})
        if r.status_code >= 400:
            return None
        imgs = (r.json().get("images") or [])
        if imgs:
            return imgs[0].get("url")
    except Exception:  # noqa
        return None
    return None


async def fetch_for(title: str, description: str = "", location: str = "") -> str | None:
    q = _query(title, description)
    url = await _pexels(q)
    if url:
        return url
    return await _fal_flux(title, description)
