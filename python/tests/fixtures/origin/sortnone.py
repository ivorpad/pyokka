"""TypeError on None: list.sort() returns None (the bug corpus's h4_sort_returns_none, branch worktree-bugs)."""

SCORES = [70, 88, 97, 64, 81]


def best(scores, n):
    ranked = scores.sort(reverse=True)
    return ranked[:n]


def main():
    print("best:", best(list(SCORES), 3))


main()
