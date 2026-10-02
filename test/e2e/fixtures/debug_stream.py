"""A program that only prints: the streaming half of the Debugger view has no other input.

argv is `LINES DOTS BURST HOLD`. The first phase prints a committed line, then grows an open line
one character at a time with no newline (the token-stream case the view draws with a caret), then
closes it, and writes to stderr every third time so the two streams interleave in the log.

The second phase prints more than the 64 KB window with no pause at all, so the head of the log is
cut between two flushes and `OutputLog.since()` can no longer cover what the view missed. That is
the one path the unit tests cannot reach: recovery by full resend rather than a silent hole.

Then it prints `done` and holds for up to HOLD seconds without printing. The hold is what makes
the spec possible at all: a debug session is disposed the moment its child exits, taking the
panel state with it, so everything about a *running* program has to be read while it still runs.
"""

import sys
import time

lines, dots, burst, hold = (int(a) for a in sys.argv[1:5])

for i in range(lines):
    print("line %d" % i, flush=True)
    for _ in range(dots):
        print(".", end="", flush=True)
        time.sleep(0.02)
    print(flush=True)
    if i % 3 == 0:
        print("warn %d" % i, file=sys.stderr, flush=True)

for i in range(burst):
    print("burst %d %s" % (i, "x" * 120), flush=True)

print("done", flush=True)

end = time.time() + hold
while time.time() < end:
    time.sleep(0.05)
