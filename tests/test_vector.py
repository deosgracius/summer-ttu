"""Offline tests for the vector/hybrid retrieval math — no OpenAI key or DB needed.

The cosine similarity and Reciprocal Rank Fusion are pure functions (the core of the
retrieval logic), and the embedding layer must degrade gracefully when no key is set.
"""
import os

os.environ.pop("OPENAI_API_KEY", None)  # assert the no-op path

from app.vector_store import cosine, reciprocal_rank_fusion
from app import embeddings


def test_cosine_identical_is_one():
    assert abs(cosine([1.0, 2.0, 3.0], [1.0, 2.0, 3.0]) - 1.0) < 1e-9


def test_cosine_orthogonal_is_zero():
    assert abs(cosine([1.0, 0.0], [0.0, 1.0])) < 1e-9


def test_cosine_handles_empty_and_mismatched():
    assert cosine([], [1.0]) == 0.0
    assert cosine([1.0, 2.0], [1.0]) == 0.0
    assert cosine([0.0, 0.0], [1.0, 1.0]) == 0.0


def test_rrf_orders_by_fused_score():
    keyword = ["ECE 3306", "ECE 3312", "ECE 2372"]
    vector = ["ECE 2372", "ECE 3306", "MATH 2350"]
    fused = reciprocal_rank_fusion([keyword, vector])
    # ECE 3306 ranks high in BOTH lists, so it should come out on top.
    assert fused[0] == "ECE 3306"
    # every id from both lists appears exactly once
    assert set(fused) == {"ECE 3306", "ECE 3312", "ECE 2372", "MATH 2350"}
    assert len(fused) == len(set(fused))


def test_rrf_empty():
    assert reciprocal_rank_fusion([]) == []
    assert reciprocal_rank_fusion([[], []]) == []


def test_embeddings_off_is_graceful():
    assert embeddings.is_configured() is False
    assert embeddings.embed_text("anything") is None
    # hashing still works without a key (used to dedupe before calling the API)
    assert embeddings.text_hash("x") == embeddings.text_hash("x")
    assert embeddings.text_hash("x") != embeddings.text_hash("y")
