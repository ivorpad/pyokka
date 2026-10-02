"""Time Machine navigation over recorded step quads: a port of ``src/timeMachine/traceModel.ts``.

Steps are ``[rid, scopeId, depth, flags]`` quads (``protocol.decode_steps``), scopes the
``trace`` event's table. A *resolver* maps a global range id to ``(fileId, range)`` or
``None``. Every move returns a step index or ``-1`` when the move is impossible, exactly
like the TypeScript model; ``test/unit/fixtures/trace-moves.json`` pins both sides.
"""

from __future__ import annotations

from array import array
from dataclasses import dataclass
from typing import Any, Callable, Sequence

from .protocol import FLAG_ERROR, FLAG_LOG

ECHO_LIMIT = 100

Location = tuple[int, list[int]]  # (fileId, [startLine, startCol, endLine, endCol])
Resolver = Callable[[int], "Location | None"]


@dataclass
class CallFrame:
    scope_id: int
    step: int
    function: str
    file_id: int
    line: int
    col: int
    rid: int


class Trace:
    def __init__(self, steps: Sequence[int] | array, scopes: list[dict], resolve: Resolver, truncated: bool = False) -> None:
        self.steps = steps
        self.scopes = scopes
        self.truncated = truncated
        self.count = len(steps) // 4
        self.scope_by_id: dict[int, dict] = {int(s["scopeId"]): s for s in scopes}
        self._resolve = resolve
        self._location_cache: dict[int, Location | None] = {}

    @classmethod
    def from_quads(cls, quads: Sequence[Sequence[int]], scopes: list[dict], resolve: Resolver) -> "Trace":
        flat = array("i")
        for q in quads:
            flat.extend((int(q[0]), int(q[1]), int(q[2]), int(q[3]) if len(q) > 3 else 0))
        return cls(flat, scopes, resolve)

    # -- accessors --------------------------------------------------------------------
    def rid(self, i: int) -> int:
        return self.steps[i * 4] if self.valid(i) else -1

    def scope_id(self, i: int) -> int:
        return self.steps[i * 4 + 1] if self.valid(i) else -1

    def depth(self, i: int) -> int:
        return self.steps[i * 4 + 2] if self.valid(i) else 0

    def flags(self, i: int) -> int:
        return self.steps[i * 4 + 3] if self.valid(i) else 0

    def scope(self, scope_id: int) -> dict | None:
        return self.scope_by_id.get(scope_id)

    def valid(self, i: int) -> bool:
        return 0 <= i < self.count

    def clamp(self, i: int) -> int:
        if self.count == 0:
            return -1
        return max(0, min(self.count - 1, i))

    def location(self, i: int) -> Location | None:
        if not self.valid(i):
            return None
        rid = self.rid(i)
        if rid not in self._location_cache:
            self._location_cache[rid] = self._resolve(rid)
        return self._location_cache[rid]

    # -- the six moves ------------------------------------------------------------------
    def step_into(self, i: int) -> int:
        return i + 1 if i + 1 < self.count else -1

    def step_back_into(self, i: int) -> int:
        return i - 1 if i - 1 >= 0 and self.count > 0 else -1

    # Over and out follow the scope's parent chain, not step depth: the next step in the current
    # scope or an ancestor (over), or in an ancestor only (out). A scope entered from another
    # task or a sibling call at the same depth is never a landing spot, so stepping over an
    # ``await gather(...)`` skips every step of the gathered tasks.
    def _lineage(self, i: int, strict: bool) -> set[int]:
        out: set[int] = set()
        sid = self.scope_id(i)
        if strict:
            s = self.scope_by_id.get(sid)
            sid = int(s["parent"]) if s else -1
        while sid >= 0 and sid not in out:
            out.add(sid)
            s = self.scope_by_id.get(sid)
            sid = int(s["parent"]) if s else -1
        return out

    def _next_in(self, i: int, scopes: set[int], direction: int) -> int:
        if not self.valid(i) or not scopes:
            return -1
        steps = self.steps
        j = i + direction
        while 0 <= j < self.count:
            if steps[j * 4 + 1] in scopes:
                return j
            j += direction
        return -1

    def step_over(self, i: int) -> int:
        return self._next_in(i, self._lineage(i, False), 1)

    def step_back_over(self, i: int) -> int:
        return self._next_in(i, self._lineage(i, False), -1)

    def step_out(self, i: int) -> int:
        return self._next_in(i, self._lineage(i, True), 1)

    def step_back_out(self, i: int) -> int:
        return self._next_in(i, self._lineage(i, True), -1)

    MOVES = ("into", "over", "out", "back", "backOver", "backOut")

    def move(self, i: int, kind: str) -> int:
        fn = {
            "into": self.step_into,
            "over": self.step_over,
            "out": self.step_out,
            "back": self.step_back_into,
            "backInto": self.step_back_into,
            "backOver": self.step_back_over,
            "backOut": self.step_back_out,
        }.get(kind)
        if fn is None:
            raise ValueError("unknown move %r" % kind)
        return fn(i)

    def moves(self, i: int) -> dict[str, int | None]:
        """The contract's ``moves`` object: step numbers, ``None`` when impossible."""
        out: dict[str, int | None] = {}
        for kind in self.MOVES:
            j = self.move(i, kind)
            out[kind] = j if j >= 0 else None
        return out

    def can_step(self, i: int) -> dict[str, bool]:
        return {
            "into": self.step_into(i) >= 0,
            "back": self.step_back_into(i) >= 0,
            "over": self.step_over(i) >= 0,
            "backOver": self.step_back_over(i) >= 0,
            "out": self.step_out(i) >= 0,
            "backOut": self.step_back_out(i) >= 0,
        }

    # -- lines ---------------------------------------------------------------------------------
    def _starts_on_line(self, j: int, file_id: int, line: int) -> bool:
        loc = self.location(j)
        return loc is not None and loc[0] == file_id and loc[1][0] == line

    def _contains_line(self, j: int, file_id: int, line: int) -> bool:
        loc = self.location(j)
        return loc is not None and loc[0] == file_id and loc[1][0] <= line <= loc[1][2]

    def run_to_line(self, i: int, file_id: int, line: int) -> int:
        for j in range(i + 1, self.count):
            if self._starts_on_line(j, file_id, line):
                return j
        for j in range(i + 1, self.count):
            if self._contains_line(j, file_id, line):
                return j
        return -1

    def run_back_to_line(self, i: int, file_id: int, line: int) -> int:
        for j in range(i - 1, -1, -1):
            if self._starts_on_line(j, file_id, line):
                return j
        for j in range(i - 1, -1, -1):
            if self._contains_line(j, file_id, line):
                return j
        return -1

    def start_step(self, file_id: int, line: int) -> int:
        """First step on ``line``, else the first step on a following line of that file, else step 0."""
        if self.count == 0:
            return -1
        for j in range(self.count):
            if self._starts_on_line(j, file_id, line):
                return j
        for j in range(self.count):
            if self._contains_line(j, file_id, line):
                return j
        best = -1
        best_line = float("inf")
        for j in range(self.count):
            loc = self.location(j)
            if loc is not None and loc[0] == file_id and line < loc[1][0] < best_line:
                best_line = loc[1][0]
                best = j
        return best if best >= 0 else 0

    def steps_on_line(self, file_id: int, line: int) -> list[int]:
        """Every step whose statement starts on ``line`` (ascending)."""
        return [j for j in range(self.count) if self._starts_on_line(j, file_id, line)]

    # -- echoes, flags, stack ----------------------------------------------------------------------
    def echo_steps(self, i: int, limit: int = ECHO_LIMIT) -> list[int]:
        if not self.valid(i):
            return []
        rid = self.rid(i)
        before: list[int] = []
        j = i - 1
        while j >= 0 and len(before) < limit:
            if self.rid(j) == rid:
                before.append(j)
            j -= 1
        after: list[int] = []
        j = i + 1
        while j < self.count and len(after) < limit:
            if self.rid(j) == rid:
                after.append(j)
            j += 1
        before.reverse()
        return before + after

    def is_log_step(self, i: int) -> bool:
        return (self.flags(i) & FLAG_LOG) != 0

    def is_error_step(self, i: int) -> bool:
        return (self.flags(i) & FLAG_ERROR) != 0

    def call_stack(self, i: int) -> list[CallFrame]:
        """Innermost frame first; outer frames point at the call sites."""
        if not self.valid(i):
            return []
        frames: list[CallFrame] = []

        def push(scope_id: int, step: int, name: str) -> None:
            loc = self.location(step)
            frames.append(CallFrame(scope_id, step, name, loc[0] if loc else -1, loc[1][0] if loc else 0, loc[1][1] if loc else 0, self.rid(step)))

        scope = self.scope_by_id.get(self.scope_id(i))
        push(self.scope_id(i), i, scope["name"] if scope else "<module>")
        seen: set[int] = set()
        while scope is not None and scope["parent"] >= 0 and scope["parent"] != scope["scopeId"] and scope["scopeId"] not in seen:
            seen.add(scope["scopeId"])
            parent = self.scope_by_id.get(scope["parent"])
            if parent is None:
                break
            call_site = -1
            for j in range(min(int(scope["first"]), self.count) - 1, -1, -1):
                if self.scope_id(j) == parent["scopeId"]:
                    call_site = j
                    break
            if call_site < 0:
                break
            push(parent["scopeId"], call_site, parent["name"])
            scope = parent
        return frames

    # -- blocks (Code Story grouping) --------------------------------------------------------------------
    def blocks(self) -> list[tuple[int, int, int]]:
        """One block per pass through a scope: ``(scopeId, firstStep, lastStep)``.

        A block runs while the scope holds and no line comes back around. A line reached again
        after leaving it is the code running again, so a loop body becomes one block per
        iteration and each block reads as a straight run down the source. Several steps can
        share a line (a call and its arguments, a comprehension), so only a line returned to
        after leaving it starts a block. Steps in another file belong to that file's own block:
        they neither end the current one nor count as a line coming back.
        """
        out: list[tuple[int, int, int]] = []
        i = 0
        while i < self.count:
            sid = self.scope_id(i)
            loc = self.location(i)
            file_id = loc[0] if loc else -1
            prev_line = loc[1][0] if loc else None
            seen = {prev_line} if prev_line is not None else set()
            j = i
            while j + 1 < self.count and self.scope_id(j + 1) == sid:
                nxt = self.location(j + 1)
                line = nxt[1][0] if nxt and nxt[0] == file_id else None
                if line is not None and line != prev_line:
                    if line in seen:
                        break
                    seen.add(line)
                if line is not None:
                    prev_line = line
                j += 1
            out.append((sid, i, j))
            i = j + 1
        return out

    def block_at(self, i: int) -> tuple[int, int, int] | None:
        """The block (see ``blocks``) containing step ``i``."""
        if not self.valid(i):
            return None
        for block in self.blocks():
            if block[1] <= i <= block[2]:
                return block
        return None

    def step_info(self, i: int) -> dict[str, Any] | None:
        if not self.valid(i):
            return None
        loc = self.location(i)
        return {
            "index": i,
            "rid": self.rid(i),
            "fileId": loc[0] if loc else -1,
            "line": loc[1][0] if loc else 0,
            "col": loc[1][1] if loc else 0,
            "scopeId": self.scope_id(i),
            "depth": self.depth(i),
            "flags": self.flags(i),
        }


__all__ = ["Trace", "CallFrame", "ECHO_LIMIT"]
