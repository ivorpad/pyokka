"""Reciprocal Rank Fusion, the same arithmetic as demo.py, as a module the API imports."""

from __future__ import annotations


def reciprocal_rank(rank: int, k: int = 60) -> float:
    """One ranking's contribution for a document at `rank` (1-based)."""
    return 1 / (k + rank)


def rrf(rankings: dict[str, list[str]], k: int = 60) -> dict[str, float]:
    """Fuse several rankings into one score per document."""
    scores: dict[str, float] = {}
    for ranking in rankings.values():
        for rank, document_id in enumerate(ranking, start=1):
            contribution = reciprocal_rank(rank, k)
            scores[document_id] = scores.get(document_id, 0.0) + contribution
    return scores


def fused_order(scores: dict[str, float]) -> list[tuple[str, float]]:
    """Documents from the best score down; ties keep their first appearance."""
    return sorted(scores.items(), key=lambda item: item[1], reverse=True)
