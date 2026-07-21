"""Text -> embedding vector, for semantic ('vector') course search.

An *embedding* is a list of numbers that captures the *meaning* of a piece of text.
Two texts about similar topics end up with vectors that point in similar directions,
so "classes about robots" can match a course titled "Autonomous Systems" even though
they share no keywords. That's what keyword search can't do.

Gracefully optional, like the rest: if no embedding provider is configured we return
None and the caller falls back to keyword-only search. Two providers are supported —
OpenAI text-embedding-3-small (1536 dims, default) and Gemini text-embedding-004
(768 dims). The active provider/model is resolved at call time from the environment.
"""
import os
import hashlib

# OpenAI default (kept for back-compat; effective_model() returns the active provider's model).
EMBED_MODEL = os.getenv("EMBED_MODEL", "text-embedding-3-small")
GEMINI_EMBED_MODEL_DEFAULT = "text-embedding-004"


def _provider():
    """Return 'gemini' | 'openai' | None. None => embeddings unconfigured (graceful skip)."""
    p = (os.getenv("LLM_PROVIDER", "") or "").lower()
    google_keyed = bool(os.getenv("GOOGLE_API_KEY") or os.getenv("GEMINI_API_KEY")
                        or os.getenv("GOOGLE_GENAI_USE_VERTEXAI"))
    if p == "gemini":
        return "gemini" if google_keyed else None
    if p == "openai":
        return "openai" if os.getenv("OPENAI_API_KEY") else None
    # No explicit provider: pick by key presence. Google preferred so a Google key alone
    # enables vector embeddings; flip these two if OpenAI should win a tie.
    if google_keyed:
        return "gemini"
    if os.getenv("OPENAI_API_KEY"):
        return "openai"
    return None


def is_configured() -> bool:
    return _provider() is not None


def effective_model() -> str:
    """The model that will actually produce vectors, given the active provider."""
    prov = _provider()
    if prov == "gemini":
        return os.getenv("GEMINI_EMBED_MODEL", GEMINI_EMBED_MODEL_DEFAULT)
    if prov == "openai":
        return os.getenv("EMBED_MODEL", "text-embedding-3-small")
    return ""


def text_hash(text: str) -> str:
    """Stable fingerprint of (effective model + text) so we only re-embed when the text
    OR the provider/model changes. Folding the active model in is load-bearing: switching
    providers changes every course's hash, forcing a re-embed at the new dimension instead
    of leaving stale 1536-d rows a 768-d query can never match."""
    blob = f"{effective_model()}\x00{text or ''}".encode("utf-8")
    return hashlib.sha256(blob).hexdigest()


def embed_text(text: str):
    """Return the embedding vector for `text` (list of floats), or None if embeddings
    aren't configured / the call fails. Synchronous — fine at this scale."""
    prov = _provider()
    if prov is None:
        return None
    payload = (text or " ")[:8000]
    try:
        if prov == "gemini":
            from google import genai
            _k = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
            client = genai.Client(api_key=_k) if _k else genai.Client()  # api-key or Vertex env
            resp = client.models.embed_content(model=effective_model(), contents=payload)
            return list(resp.embeddings[0].values)   # 768-d
        import openai
        client = openai.OpenAI(api_key=os.environ["OPENAI_API_KEY"])
        resp = client.embeddings.create(model=effective_model(), input=payload)
        return list(resp.data[0].embedding)          # 1536-d
    except Exception:
        return None
