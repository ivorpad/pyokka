# Fixture of test/e2e/tour.test.js: two rankings fused by reciprocal rank, then printed.
# The e2e suite reads its tour; keep its shape (three calls from main, one print at the end).


def parse(line):
    name, score = line.split(":")
    return name.strip(), float(score)


def load(lines):
    rows = []
    for line in lines:
        rows.append(parse(line))
    return sorted(rows, key=lambda r: -r[1])


def fuse(rankings, k=60):
    scores = {}
    for ranking in rankings:
        for rank, (name, _score) in enumerate(ranking, start=1):
            scores[name] = scores.get(name, 0) + 1 / (k + rank)
    return sorted(scores.items(), key=lambda kv: -kv[1])


def main():
    bm25 = load(["alpha: 3.2", "beta: 2.9", "gamma: 1.1"])
    vector = load(["gamma: 0.91", "alpha: 0.88", "delta: 0.40"])
    fused = fuse([bm25, vector])
    best = fused[0][0]
    print("best:", best)


main()
