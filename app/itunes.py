"""Apple Music / iTunes lookup via Apple's free iTunes Search API (no key, no
account). Returns a track with a 30-second preview (playable in the browser) and
a link to open the full song in Apple Music.

Full in-app playback of whole tracks would require MusicKit (an Apple Developer
account + the user's Apple Music subscription); this free path covers search,
preview, and open-in-Apple-Music."""
import httpx

SEARCH = "https://itunes.apple.com/search"


async def search(query: str, limit: int = 5):
    q = (query or "").strip()
    if not q:
        return {"error": "What song or artist should I look up?"}
    try:
        async with httpx.AsyncClient(timeout=15) as c:
            r = await c.get(SEARCH, params={"term": q, "media": "music",
                                            "entity": "song", "limit": limit})
            if r.status_code >= 300:
                return {"error": f"Apple Music lookup failed ({r.status_code})."}
            results = r.json().get("results", [])
    except Exception as e:
        return {"error": f"Apple Music lookup failed: {e}"}
    tracks = []
    for t in results:
        if not t.get("trackName"):
            continue
        tracks.append({
            "track": t.get("trackName"),
            "artist": t.get("artistName"),
            "album": t.get("collectionName"),
            "preview_url": t.get("previewUrl"),       # 30s mp3, playable in-browser
            "apple_music_url": t.get("trackViewUrl"),  # opens the full song in Apple Music
            "artwork": t.get("artworkUrl100"),
        })
    if not tracks:
        return {"info": f"No Apple Music results for '{q}'."}
    return {"query": q, "tracks": tracks}
