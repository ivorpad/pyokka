"""The loop the step-latency measurements step through (handoff item 4).

argv is `N HEAVY`. The body is four small assignments either way; `HEAVY` only changes what else
is in the frame, because that is the question: a stop serialises the frame's locals, so does the
cost of a step depend on what is in scope, or only on how many statements were run?

N must be large enough that stepping cannot exhaust the loop. The first attempt at this used 500,
the program finished part way through a batch, and the later calls returned errors quickly enough
to look like fast steps, which is what produced the nonsense number in the handoff.
"""

import sys

n = int(sys.argv[1])
heavy = len(sys.argv) > 2 and sys.argv[2] == "heavy"

if heavy:
    rows = [{"id": i, "name": "row-%d" % i, "tags": ["a", "b", "c"], "score": i * 1.5} for i in range(2000)]
    lookup = {r["name"]: r for r in rows}

total = 0
for i in range(n):
    a = i * 2
    b = a + 1
    c = b % 7
    total = total + c

print(total)
