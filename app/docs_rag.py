"""Unstructured-document RAG: ingest a file -> chunk -> embed -> retrieve.

This is the "real" RAG pipeline (vs. retrieval over structured course rows): an admin
uploads a handbook / policy / syllabus, we split it into overlapping chunks, embed each
chunk, and at query time return the most relevant passages **with citations** so the
assistant answers from the document instead of guessing.

Reuses the existing pieces:
  * `embeddings.embed_text` — same model/keys as the course vector search.
  * cosine similarity — same pure-Python approach as `vector_store` (works on SQLite;
    the production note about swapping in pgvector applies here too).

Gracefully optional: if embeddings aren't configured, chunks are still stored and
retrieval falls back to keyword matching, so the feature degrades instead of breaking.
"""
import re
import json
from . import models, embeddings
from .vector_store import cosine

# Chunking defaults — ~800 chars (~150-200 tokens) with overlap so a passage that
# straddles a boundary still appears whole in at least one chunk.
TARGET_CHARS = 800
OVERLAP_CHARS = 120


def _hard_units(s: str, target: int) -> list:
    """Split a long paragraph into <= target-sized pieces, preferring sentence
    boundaries and falling back to word boundaries for very long sentences."""
    out = []
    for sent in re.split(r"(?<=[.!?])\s+", s):
        sent = sent.strip()
        if not sent:
            continue
        if len(sent) <= target:
            out.append(sent)
            continue
        buf = ""
        for w in sent.split():
            if buf and len(buf) + 1 + len(w) > target:
                out.append(buf)
                buf = w
            else:
                buf = (buf + " " + w).strip() if buf else w
        if buf:
            out.append(buf)
    return out


def chunk_text(text: str, target_chars: int = TARGET_CHARS,
               overlap_chars: int = OVERLAP_CHARS) -> list:
    """Split text into overlapping, semantically-coherent chunks.

    Strategy: keep paragraphs together when they fit; split oversized paragraphs on
    sentence/word boundaries; greedily pack units up to `target_chars`; carry an
    `overlap_chars` tail from each chunk into the next so context isn't lost at seams.
    """
    text = (text or "").strip()
    if not text:
        return []
    paras = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    units = []
    for p in paras:
        units.extend([p] if len(p) <= target_chars else _hard_units(p, target_chars))

    chunks, cur = [], ""
    for u in units:
        if cur and len(cur) + 1 + len(u) > target_chars:
            chunks.append(cur)
            tail = cur[-overlap_chars:] if overlap_chars else ""
            cur = (tail + " " + u).strip() if tail else u
        else:
            cur = (cur + " " + u).strip() if cur else u
    if cur:
        chunks.append(cur)
    return chunks


def extract_text(filename: str, raw: bytes) -> tuple:
    """Return (text, kind) extracted from an uploaded file. Supports .txt/.md natively
    and .pdf via pypdf (lazy import). Raises ValueError on unsupported/garbled input."""
    name = (filename or "").lower()
    if name.endswith(".pdf"):
        try:
            import pypdf
            import io
            reader = pypdf.PdfReader(io.BytesIO(raw))
            text = "\n\n".join((page.extract_text() or "") for page in reader.pages)
        except ImportError:
            raise ValueError("PDF support needs the 'pypdf' package (pip install pypdf).")
        except Exception as e:
            raise ValueError(f"Could not read the PDF: {e}")
        return text, "pdf"
    # text / markdown / anything decodable
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        text = raw.decode("latin-1", errors="ignore")
    return text, ("markdown" if name.endswith((".md", ".markdown")) else "text")


def ingest_document(db, title: str, source: str, text: str, kind: str = "text") -> dict:
    """Chunk + embed `text` and store it as a Document with DocumentChunks.
    Returns a summary. Embeds each chunk if embeddings are configured; otherwise the
    chunks are stored without vectors (keyword retrieval still works)."""
    chunks = chunk_text(text)
    if not chunks:
        return {"error": "The document had no readable text."}

    doc = models.Document(title=title or source or "Untitled",
                          source=source, kind=kind,
                          char_count=len(text), chunk_count=len(chunks))
    db.add(doc)
    db.flush()  # get doc.id

    embedded = 0
    for i, ch in enumerate(chunks):
        vec = embeddings.embed_text(ch) if embeddings.is_configured() else None
        if vec is not None:
            embedded += 1
        db.add(models.DocumentChunk(
            document_id=doc.id, ordinal=i, text=ch,
            vector=json.dumps(vec) if vec is not None else "[]",
            model=embeddings.EMBED_MODEL if vec is not None else ""))
    db.commit()
    return {"document_id": doc.id, "title": doc.title, "chunks": len(chunks),
            "embedded": embedded, "embeddings_on": embeddings.is_configured()}


def _keyword_score(text: str, query: str) -> float:
    """Fallback relevance when there are no vectors: fraction of query words present."""
    toks = [t for t in re.findall(r"\w+", (query or "").lower()) if len(t) > 2]
    if not toks:
        return 0.0
    low = text.lower()
    return sum(1 for t in toks if t in low) / len(toks)


def search_documents(db, query: str, limit: int = 5) -> dict:
    """Return the most relevant document passages for `query`, each with a citation
    (document title + section ordinal). Uses vector similarity when available, else
    keyword overlap."""
    query = (query or "").strip()
    if not query:
        return {"matches": []}
    rows = db.query(models.DocumentChunk).all()
    if not rows:
        return {"matches": [], "note": "No documents have been uploaded yet."}

    titles = {d.id: d.title for d in db.query(models.Document).all()}
    qvec = embeddings.embed_text(query) if embeddings.is_configured() else None

    scored = []
    for r in rows:
        if qvec is not None and r.vector and r.vector != "[]":
            try:
                score = cosine(qvec, json.loads(r.vector))
            except Exception:
                score = 0.0
        else:
            score = _keyword_score(r.text, query)
        if score > 0:
            scored.append((score, r))

    scored.sort(key=lambda sr: sr[0], reverse=True)
    matches = [{
        "document": titles.get(r.document_id, "document"),
        "section": r.ordinal + 1,
        "text": r.text,
        "score": round(float(score), 3),
        "citation": f"{titles.get(r.document_id, 'document')} (section {r.ordinal + 1})",
    } for score, r in scored[:limit]]
    return {"matches": matches, "vector": qvec is not None}


def list_documents(db) -> list:
    return [{"id": d.id, "title": d.title, "source": d.source, "kind": d.kind,
             "chars": d.char_count, "chunks": d.chunk_count} for d in
            db.query(models.Document).order_by(models.Document.id).all()]


def delete_document(db, doc_id: int) -> bool:
    doc = db.get(models.Document, doc_id)
    if not doc:
        return False
    db.query(models.DocumentChunk).filter_by(document_id=doc_id).delete()
    db.delete(doc)
    db.commit()
    return True
