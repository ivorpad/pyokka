"""``pyokka tour RUN|--live [--goal NAME|F:L] [--budget TOKENS] [--prose PATH] [--out PATH] [--json]``: the parser and the command."""

from __future__ import annotations

import argparse
import json
from typing import Any, Callable

from .build import DEFAULT_BUDGET, build_tour

PROSE_EXAMPLE = '{"intro": "...", "chapters": {"c1": {"title": "...", "text": "..."}}, "pick": ["s12-ab12cd"], "stops": {"s12-ab12cd": {"title": "...", "text": "..."}}}'


def add_tour_parser(sub: argparse._SubParsersAction, run_arg: Callable[[argparse.ArgumentParser], None]) -> None:
    p = sub.add_parser("tour", help="chapters and candidate stops of a run, every value from the recording: the input a tour is picked and narrated from (docs/TOUR.md)")
    run_arg(p)
    p.add_argument("--goal", metavar="NAME|FILE:LINE", help="explain this value instead of the program's output: a variable (its last recorded value) or a line (its last pass)")
    p.add_argument("--budget", type=int, default=DEFAULT_BUDGET, metavar="TOKENS", help="keep the JSON under about this many tokens, at 4 characters a token (default %d)" % DEFAULT_BUDGET)
    p.add_argument("--prose", metavar="PATH", help="tour.prose.json (picks, titles, text, quotes by range): check it against the run and merge it; a rejection lists every problem and exits 2. Give the same --goal and --budget as the tour the prose was written from")
    p.add_argument("--out", metavar="PATH", help="write the tour, merged with --prose when given, to this file as compact JSON")


def run_tour(args: Any, source: Any) -> dict:
    from ..source import AgentError, SavedRun

    if args.budget is not None and args.budget < 1000:
        raise AgentError("--budget %d is too small for a tour" % args.budget, "give at least 1000 tokens; the default is %d" % DEFAULT_BUDGET)
    if isinstance(source, SavedRun):
        run = source
    else:
        if not hasattr(source, "recording"):
            raise AgentError("tour needs a saved run or a live session", "`pyokka tour run.json`, or `pyokka tour --live`")
        doc = source.recording()
        run = SavedRun(str(doc.get("meta", {}).get("file") or "live-session.json"), doc=doc)
    full: dict[str, str] = {}
    tour = build_tour(run, goal=(args.goal or "").strip() or None, budget=args.budget or DEFAULT_BUDGET, full=full)
    prose_path = getattr(args, "prose", None)
    if prose_path:
        from .prose import apply_prose

        try:
            with open(prose_path, "r", encoding="utf-8") as fh:
                prose = json.load(fh)
        except (OSError, ValueError) as exc:
            raise AgentError("cannot read the prose file %s: %s" % (prose_path, exc), "a JSON object: " + PROSE_EXAMPLE) from None
        tour = apply_prose(tour, prose, full)
    out = getattr(args, "out", None)
    if out:
        try:
            with open(out, "w", encoding="utf-8") as fh:
                json.dump(tour, fh, ensure_ascii=False, separators=(",", ":"))
        except OSError as exc:
            raise AgentError("cannot write %s: %s" % (out, exc)) from None
    return tour


__all__ = ["add_tour_parser", "run_tour"]
