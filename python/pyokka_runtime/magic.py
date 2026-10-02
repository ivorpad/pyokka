"""Comment-driven features: ``# ?`` live comments, coverage-ignore hints, snap fences, inline config.

Comments are found with ``tokenize`` so text inside strings is never mistaken
for a marker. Grammar of a live comment (the whitespace-insensitive suffix
must be one of ``""``, ``+``, ``.``, ``.+``, ``+.``):

    # ?            log the value
    # ?+           log and auto-expand
    # ?.           time the expression
    # ?.+  # ?+.   time and log auto-expanded
    # ? $.upper()  run code against the value (``$``), log the result
"""

from __future__ import annotations

import ast
import io
import re
import textwrap
import tokenize
from dataclasses import dataclass

from .protocol import KIND_AUTO_EXPAND, KIND_TIME, KIND_TIME_AUTO_EXPAND, KIND_VALUE

MAGIC_RE = re.compile(r"^#\s*\?\s*([.+\s]*)(.*)$", re.S)
SUFFIX_KINDS = {
    "": KIND_VALUE,
    "+": KIND_AUTO_EXPAND,
    ".": KIND_TIME,
    ".+": KIND_TIME_AUTO_EXPAND,
    "+.": KIND_TIME_AUTO_EXPAND,
}
DOLLAR_NAME = "_pk_d"
SNAP_OPEN = "{{"
SNAP_CLOSE = "}}"


@dataclass
class Comment:
    line: int
    col: int
    text: str


@dataclass
class MagicComment:
    line: int
    col: int
    kind: str
    code: ast.expr | None
    code_text: str | None


@dataclass
class Snap:
    fence: ast.Expr
    tree: ast.Module | None
    error: str | None
    start_line: int


def scan_comments(source: str) -> list[Comment]:
    out: list[Comment] = []
    try:
        for tok in tokenize.generate_tokens(io.StringIO(source).readline):
            if tok.type == tokenize.COMMENT:
                out.append(Comment(tok.start[0], tok.start[1], tok.string))
    except (tokenize.TokenError, SyntaxError, IndentationError):
        pass
    return out


def parse_dollar_code(text: str) -> ast.expr | None:
    code = re.sub(r"\$", DOLLAR_NAME, text)
    try:
        return ast.parse(code, mode="eval").body
    except SyntaxError:
        return None


def find_magic(comments: list[Comment]) -> list[MagicComment]:
    out: list[MagicComment] = []
    for c in comments:
        m = MAGIC_RE.match(c.text)
        if not m:
            continue
        suffix = re.sub(r"\s+", "", m.group(1))
        rest = m.group(2).strip()
        if suffix not in SUFFIX_KINDS:
            continue
        code = None
        if rest:
            code = parse_dollar_code(rest)
            if code is None:
                continue  # `# ? just a question` is a human comment
        out.append(MagicComment(c.line, c.col, SUFFIX_KINDS[suffix], code, rest or None))
    return out


def find_ignores(comments: list[Comment], ignore_pattern: str, ignore_file_pattern: str) -> tuple[set[int], bool]:
    lines: set[int] = set()
    ignore_file = False
    try:
        line_re = re.compile(ignore_pattern) if ignore_pattern else None
    except re.error:
        line_re = None
    try:
        file_re = re.compile(ignore_file_pattern) if ignore_file_pattern else None
    except re.error:
        file_re = None
    for c in comments:
        body = c.text.lstrip("#").strip()
        if file_re and file_re.search(body):
            ignore_file = True
        elif line_re and line_re.search(body):
            lines.add(c.line)
    return lines, ignore_file


def inline_config(tree: ast.Module) -> dict | None:
    """A leading ``{"key": value}`` dict literal is Pyokka's inline config; the caller removes it."""
    if not tree.body:
        return None
    first = tree.body[0]
    if not (isinstance(first, ast.Expr) and isinstance(first.value, ast.Dict) and first.value.keys):
        return None
    if not all(isinstance(k, ast.Constant) and isinstance(k.value, str) for k in first.value.keys):
        return None
    try:
        value = ast.literal_eval(first.value)
    except Exception:  # noqa: BLE001
        return None
    return value if isinstance(value, dict) else None


def is_snap_fence(stmt: ast.stmt) -> bool:
    if not (isinstance(stmt, ast.Expr) and isinstance(stmt.value, ast.Constant) and isinstance(stmt.value.value, str)):
        return False
    text = stmt.value.value.strip()
    return text.startswith(SNAP_OPEN) and text.endswith(SNAP_CLOSE)


def extract_snaps(tree: ast.Module, source: str) -> list[Snap]:
    snaps: list[Snap] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Expr) and is_snap_fence(node):
            snaps.append(_snap_from_fence(node, source))
    snaps.sort(key=lambda s: s.start_line)
    return snaps


def _snap_from_fence(fence: ast.Expr, source: str) -> Snap:
    const = fence.value
    literal = ast.get_source_segment(source, const) or ""
    open_idx = literal.find(SNAP_OPEN)
    close_idx = literal.rfind(SNAP_CLOSE)
    if open_idx < 0 or close_idx < 0 or close_idx <= open_idx:
        return Snap(fence, None, "snap fence not found in source", const.lineno)
    inner = literal[open_idx + 2 : close_idx]
    start_line = const.lineno + literal.count("\n", 0, open_idx + 2)
    last_nl = literal.rfind("\n", 0, open_idx + 2)
    first_col = (const.col_offset if last_nl == -1 else 0) + (open_idx + 2 - (last_nl + 1))
    lines = inner.split("\n")
    lines[0] = " " * first_col + lines[0]
    if lines[0].strip() == "":
        lines[0] = ""
    text = "\n".join(lines)
    dedented = textwrap.dedent(text)
    width = 0
    for a, b in zip(text.split("\n"), dedented.split("\n")):
        if b.strip():
            width = len(a) - len(b)
            break
    try:
        snap_tree = ast.parse(dedented, mode="exec")
    except SyntaxError as exc:
        return Snap(fence, None, "SyntaxError: %s (snap line %s)" % (exc.msg, (exc.lineno or 1) + start_line - 1), start_line)
    ast.increment_lineno(snap_tree, start_line - 1)
    if width:
        for sub in ast.walk(snap_tree):
            if hasattr(sub, "col_offset") and sub.col_offset is not None:
                sub.col_offset += width
                if getattr(sub, "end_col_offset", None) is not None:
                    sub.end_col_offset += width
    return Snap(fence, snap_tree, None, start_line)
