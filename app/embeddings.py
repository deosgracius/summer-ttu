"""Text -> embedding vector, for semantic ('vector') course search.

An *embedding* is a list of numbers (here 1536 of them) that captures the *meaning*
of a piece of text. Two texts about similar topics end up with vectors that point in
similar directions, so "classes about robots" can match a course titled "Autonomous
Systems" even though they share no keywords. That's what keyword search can't do.

Gracefully optional, like the rest: if OPENAI_API_KEY isn't set we return None and the
caller falls back to keyword-only search. Uses OpenAI's text-embedding-3-small by
default (cheap, 1536 dims); set EMBED_MODEL to override.
"""
import os
import hashlib

EMBED_MODEL = os.getenv("EMBED_MODEL", "text-embedding-3-small")


def is_configured() -> bool:
    return bool(os.getenv("OPENAI_API_KEY"))


def text_hash(text: str) -> str:
    """Stable fingerprint of (model + text) so we only re-embed when text changes."""
    blob = f"{EMBED_MODEL}\x00{text or ''}".encode("utf-8")
    return hashlib.sha256(blob).hexdigest()


def embed_text(text: str):
    """Return the embedding vector for `text` (list of floats), or None if embeddings
    aren't configured / the call fails. Synchronous — fine at this scale."""
    if not is_configured():
        return None
    try:
        import openai
        client = openai.OpenAI(api_key=os.environ["OPENAI_API_KEY"])
        # cap length defensively; embedding inputs have a token limit
        resp = client.embeddings.create(model=EMBED_MODEL, input=(text or " ")[:8000])
        return list(resp.data[0].embedding)
    except Exception:
        return None
