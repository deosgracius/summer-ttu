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

# Every search used to pull the WHOLE chunk table — text plus the full vector JSON — out of the
# database, on every question. That is real egress on a hosted Postgres, it repeats for identical
# questions, and it grows with each file the department uploads. Chunks only change when a
# document is ingested or deleted, both of which go through this module, so cache them here and
# drop the cache on those writes.
_CHUNK_CACHE: list | None = None
_CHUNK_CACHE_TITLES: dict | None = None
_CHUNK_CACHE_MAX = 4000  # stop caching if the corpus grows past this many chunks


def _invalidate_chunk_cache() -> None:
    global _CHUNK_CACHE, _CHUNK_CACHE_TITLES
    _CHUNK_CACHE = None
    _CHUNK_CACHE_TITLES = None


class _Chunk:
    """A detached copy of the columns scoring actually reads. Plain attributes, so a cached chunk
    never touches a closed session or keeps ORM identity-map state alive."""
    __slots__ = ("document_id", "ordinal", "text", "vector")

    def __init__(self, document_id, ordinal, text, vector):
        self.document_id = document_id
        self.ordinal = ordinal
        self.text = text
        self.vector = vector

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


def _xlsx_text(raw: bytes) -> str:
    """Every sheet as tab-separated rows, with the sheet name as a heading. openpyxl is already
    a dependency (the registrar importer uses it). read_only + values_only keeps big workbooks
    cheap, and blank rows are dropped so the chunks stay meaningful."""
    import io
    import openpyxl
    wb = openpyxl.load_workbook(io.BytesIO(raw), read_only=True, data_only=True)
    out = []
    for ws in wb.worksheets:
        rows = []
        for row in ws.iter_rows(values_only=True):
            cells = ["" if c is None else str(c).strip() for c in row]
            if any(cells):
                rows.append("\t".join(cells).rstrip())
        if rows:
            out.append(f"# {ws.title}\n" + "\n".join(rows))
    wb.close()
    return "\n\n".join(out)


def _ooxml_text(raw: bytes, member_glob: str, tag: str, para_tag: str = "") -> str:
    """Pull the visible text out of a .docx/.pptx without any extra dependency: both are ZIPs of
    XML, so read the parts we want and collect the text runs. `para_tag` (when given) marks a
    paragraph/line break so the output keeps its structure instead of running together."""
    import io
    import re as _re
    import zipfile
    parts = []
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        names = sorted(n for n in z.namelist() if _re.fullmatch(member_glob, n))
        for n in names:
            xml = z.read(n).decode("utf-8", errors="ignore")
            if para_tag:
                xml = _re.sub(rf"</{para_tag}>", "\n", xml)
            # <w:t>text</w:t> / <a:t>text</a:t>
            chunks = _re.findall(rf"<{tag}[^>]*>(.*?)</{tag}>", xml, _re.S)
            text = "".join(chunks)
            # strip any leftover markup, then unescape the five XML entities
            text = _re.sub(r"<[^>]+>", "", text)
            for a, b in (("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", '"'), ("&apos;", "'")):
                text = text.replace(a, b)
            text = _re.sub(r"\n{3,}", "\n\n", text).strip()
            if text:
                parts.append(text)
    return "\n\n".join(parts)


def extract_text(filename: str, raw: bytes) -> tuple:
    """Return (text, kind) extracted from an uploaded file.

    Handles the formats the department actually sends: Excel (.xlsx/.xlsm), Word (.docx),
    PowerPoint (.pptx), PDF, and plain text/markdown. Office files are ZIP archives, so without
    a real extractor they used to fall through to the latin-1 decode below and get embedded as
    binary garbage — searchable nonsense that polluted answers. Raises ValueError on unsupported
    or unreadable input so the caller can say so instead of storing junk."""
    name = (filename or "").lower()
    if name.endswith((".xlsx", ".xlsm")):
        try:
            text = _xlsx_text(raw)
        except Exception as e:
            raise ValueError(f"Could not read the spreadsheet: {e}")
        if not text.strip():
            raise ValueError("That spreadsheet had no readable cells.")
        return text, "spreadsheet"
    if name.endswith(".docx"):
        try:
            text = _ooxml_text(raw, r"word/document\.xml", "w:t", para_tag="w:p")
        except Exception as e:
            raise ValueError(f"Could not read the Word document: {e}")
        if not text.strip():
            raise ValueError("That Word document had no readable text.")
        return text, "document"
    if name.endswith(".pptx"):
        try:
            text = _ooxml_text(raw, r"ppt/slides/slide\d+\.xml", "a:t", para_tag="a:p")
        except Exception as e:
            raise ValueError(f"Could not read the presentation: {e}")
        if not text.strip():
            raise ValueError("That presentation had no readable text.")
        return text, "slides"
    if name.endswith((".doc", ".ppt", ".xls")):
        raise ValueError("That's the old Office format. Please save it as .docx, .pptx, or .xlsx and upload again.")
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
            model=embeddings.effective_model() if vec is not None else ""))
    db.commit()
    _invalidate_chunk_cache()  # new chunks -> the cached corpus is stale
    return {"document_id": doc.id, "title": doc.title, "chunks": len(chunks),
            "embedded": embedded, "embeddings_on": embeddings.is_configured()}


def ingest_or_replace(db, title: str, source: str, text: str, kind: str = "text") -> dict:
    """Ingest a document, REPLACING any earlier version with the same source.

    Uploading the same file again (a corrected electives list, say) should update what Summer
    knows, not stack a second stale copy alongside it — otherwise retrieval starts returning
    last month's schedule with equal confidence. Same-source chunks are deleted first, so
    re-uploading is always safe and idempotent."""
    old = db.query(models.Document).filter(models.Document.source == source).all()
    replaced = 0
    for d in old:
        db.query(models.DocumentChunk).filter(models.DocumentChunk.document_id == d.id).delete()
        db.delete(d)
        replaced += 1
    if replaced:
        db.flush()
    res = ingest_document(db, title, source, text, kind)
    if replaced:
        res["replaced"] = replaced
    return res


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
    global _CHUNK_CACHE, _CHUNK_CACHE_TITLES
    if _CHUNK_CACHE is not None:
        rows, titles = _CHUNK_CACHE, _CHUNK_CACHE_TITLES or {}
    else:
        rows = db.query(models.DocumentChunk).all()
        titles = {d.id: d.title for d in db.query(models.Document).all()}
        # Detach from the session and keep only what scoring needs, so cached rows can't go stale
        # against a closed session or hold ORM state alive.
        if len(rows) <= _CHUNK_CACHE_MAX:
            _CHUNK_CACHE = [_Chunk(r.document_id, r.ordinal, r.text, r.vector) for r in rows]
            _CHUNK_CACHE_TITLES = titles
            rows = _CHUNK_CACHE
    if not rows:
        return {"matches": [], "note": "No documents have been uploaded yet."}
    qvec = embeddings.embed_text(query) if embeddings.is_configured() else None

    scored = []
    for r in rows:
        score = None
        if qvec is not None and r.vector and r.vector != "[]":
            try:
                vec = json.loads(r.vector)
                # Only compare when the dimensions agree. A provider switch (e.g. OpenAI's
                # 1536-d -> Gemini's 768-d) leaves stale rows of the old width; cosine() on
                # mismatched lengths would raise or mislead, so fall through to keyword
                # overlap for those rows instead of dropping them from the results.
                if len(vec) == len(qvec):
                    score = cosine(qvec, vec)
            except Exception:
                score = None
        if score is None:
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
    _invalidate_chunk_cache()  # chunks removed -> the cached corpus is stale
    return True
