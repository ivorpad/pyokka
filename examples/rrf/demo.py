"""
rrf_demo.py

A small program for understanding Reciprocal Rank Fusion (RRF).

Run:
    python rrf_demo.py
"""

from dataclasses import dataclass
from typing import Dict, List


@dataclass
class Document:
    id: str
    text: str


DOCUMENTS = {
    "A": Document("A", "Button component with primary and secondary variants"),
    "B": Document("B", "Form input component with validation"),
    "C": Document("C", "Primary button used for important actions"),
    "D": Document("D", "Navigation menu and sidebar"),
    "E": Document("E", "CTA component for submitting forms"),
}


# Imagine these came from two completely different retrieval systems.
#
# BM25 cares about lexical/token overlap.
# Vector search cares about semantic similarity.

bm25_ranking = [
    "A",  # rank 1
    "C",  # rank 2
    "B",  # rank 3
    "D",  # rank 4
]

vector_ranking = [
    "C",  # rank 1
    "E",  # rank 2
    "A",  # rank 3
    "B",  # rank 4
]


def reciprocal_rank(rank: int, k: int = 60) -> float:
    """
    Contribution produced by one ranking.

    rank=1 -> 1 / (k + 1)
    rank=2 -> 1 / (k + 2)
    ...
    """
    return 1 / (k + rank)


def rrf(
    rankings: Dict[str, List[str]],
    k: int = 60,
) -> Dict[str, float]:

    scores: Dict[str, float] = {}

    for ranking_name, ranking in rankings.items():

        print(f"\n--- {ranking_name} ---")

        for rank, document_id in enumerate(ranking, start=1):

            contribution = reciprocal_rank(rank, k)

            print(
                f"{document_id}: "
                f"rank={rank} "
                f"=> 1 / ({k} + {rank}) "
                f"= {contribution:.6f}"
            )

            scores[document_id] = (
                scores.get(document_id, 0)
                + contribution
            )

    return scores


def print_ranking(title: str, ranking: List[str]) -> None:

    print(f"\n{title}")

    for rank, document_id in enumerate(ranking, start=1):
        document = DOCUMENTS[document_id]

        print(
            f"{rank}. {document_id}: "
            f"{document.text}"
        )


def main():

    print("=" * 70)
    print("RECIPROCAL RANK FUSION")
    print("=" * 70)

    print_ranking("BM25 ranking", bm25_ranking)
    print_ranking("Vector ranking", vector_ranking)

    rankings = {
        "BM25": bm25_ranking,
        "Vector": vector_ranking,
    }

    print("\n\nCalculating RRF contributions...")

    scores = rrf(
        rankings=rankings,
        k=60,
    )

    fused_ranking = sorted(
        scores.items(),
        key=lambda item: item[1],
        reverse=True,
    )

    print("\n")
    print("=" * 70)
    print("FINAL RRF RANKING")
    print("=" * 70)

    for position, (document_id, score) in enumerate(
        fused_ranking,
        start=1,
    ):
        document = DOCUMENTS[document_id]

        print(
            f"{position}. {document_id} "
            f"RRF={score:.6f}"
        )
        print(f"   {document.text}")

    print("\n")
    print("=" * 70)
    print("WHY DID EACH DOCUMENT GET THAT SCORE?")
    print("=" * 70)

    all_documents = set()

    for ranking in rankings.values():
        all_documents.update(ranking)

    for document_id in sorted(all_documents):

        print(f"\nDocument {document_id}")

        total = 0

        for ranking_name, ranking in rankings.items():

            if document_id not in ranking:
                print(
                    f"  {ranking_name:10}: "
                    "not retrieved -> +0"
                )
                continue

            rank = ranking.index(document_id) + 1
            contribution = reciprocal_rank(rank, k=60)

            total += contribution

            print(
                f"  {ranking_name:10}: "
                f"rank {rank} "
                f"-> 1/(60+{rank}) "
                f"= {contribution:.6f}"
            )

        print(f"  {'TOTAL':10}: {total:.6f}")


if __name__ == "__main__":
    main()