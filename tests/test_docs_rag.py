"""Offline tests for the document RAG pipeline — the chunker and keyword fallback are
pure functions, no embeddings/DB/network needed.
"""
import os
os.environ.pop("OPENAI_API_KEY", None)  # exercise the no-embeddings fallback path

from app.docs_rag import chunk_text, _keyword_score, _hard_units


def test_chunk_empty():
    assert chunk_text("") == []
    assert chunk_text("   ") == []
    assert chunk_text(None) == []


def test_short_text_is_one_chunk():
    assert chunk_text("A short handbook line.") == ["A short handbook line."]


def test_chunks_respect_target_size():
    text = "\n\n".join("Paragraph number %d has some words in it." % i for i in range(50))
    chunks = chunk_text(text, target_chars=200, overlap_chars=40)
    assert len(chunks) > 1
    # allow a little slack for the carried-over overlap tail
    assert all(len(c) <= 200 + 40 + 60 for c in chunks)


def test_chunks_have_overlap():
    text = "\n\n".join("Sentence block %d." % i for i in range(40))
    chunks = chunk_text(text, target_chars=120, overlap_chars=40)
    # consecutive chunks should share some trailing/leading text (overlap)
    overlaps = 0
    for a, b in zip(chunks, chunks[1:]):
        if a[-20:].strip() and a[-20:].strip().split()[-1] in b[:60]:
            overlaps += 1
    assert overlaps >= 1


def test_oversized_paragraph_is_split():
    big = "word " * 500  # ~2500 chars, no paragraph breaks
    chunks = chunk_text(big, target_chars=300, overlap_chars=0)
    assert len(chunks) > 1
    assert all(len(c) <= 300 + 60 for c in chunks)


def test_hard_units_prefers_sentences():
    s = "First sentence here. Second sentence here. Third one too."
    units = _hard_units(s, target=30)
    assert all(len(u) <= 30 for u in units)
    assert any("First sentence" in u for u in units)


def test_keyword_score():
    assert _keyword_score("The drop deadline is Friday in room 204.", "drop deadline") == 1.0
    assert _keyword_score("Totally unrelated text.", "drop deadline") == 0.0
    # short stop-ish tokens (<=2 chars) are ignored, so an all-short query scores 0
    assert _keyword_score("anything", "of to in") == 0.0
