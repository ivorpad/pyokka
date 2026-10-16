"""The ``review`` subparser: ``pyokka review ACTION ...`` with one nested parser per action.

The fields are the ones the ``pyokka_review`` MCP tool takes under the same names (``mcp_tools.py``);
``actions.run`` reads them from a dict, so the CLI's ``Namespace`` and the tool's arguments go
down one path. ``--dir`` is accepted by every action; the default is the current review.
"""

from __future__ import annotations

import argparse

from .state import SEVERITIES, SURFACES

HELP = "review a change as a guided debug session: start records base and head and plans the stops; stop N --say TEXT shows one (it must name a value there); ask, try, finding add, fix, report, state. Every answer starts with the review's header and ends with a next: line"


def add_review_parser(sub: argparse._SubParsersAction) -> None:
    p = sub.add_parser("review", help=HELP, description=HELP)
    p.set_defaults(run=None, live=False, session=None, action=None, what="add")
    p.add_argument("--json", action="store_true", help="print the raw JSON shape")
    acts = p.add_subparsers(dest="action", metavar="ACTION")

    def dir_arg(q: argparse.ArgumentParser) -> None:
        q.add_argument("--dir", metavar="DIR", help="the review directory (default: the current review, the one start last made)")
        q.add_argument("--json", action="store_true", default=argparse.SUPPRESS, help="print the raw JSON shape (also accepted before the action)")

    def view_args(q: argparse.ArgumentParser) -> None:
        q.add_argument("--say", metavar="TEXT", help="the explanation at this stop; it must name one of the stop's values, the fact's before or after text, or the step number")
        q.add_argument("--surface", choices=list(SURFACES), default="auto", help="where the person watches: auto picks the first that answers (the page on --port, a VS Code session, else chat)")
        q.add_argument("--port", type=int, default=None, metavar="P", help="the page's port (default $PYOKKA_PORT, else 4777)")
        q.add_argument("--session", metavar="NAME", help="the VS Code session's file name, when more than one is open")
        dir_arg(q)

    s = acts.add_parser("start", help="record base and head, compare them and plan the stops")
    s.add_argument("--base", required=True, metavar="REF", help="the base commit (a ref the repo resolves)")
    s.add_argument("--repo", metavar="DIR", help="the git checkout under review (default: the current directory)")
    g = s.add_mutually_exclusive_group()
    g.add_argument("--entry", metavar="FILE", help="the file both trees run (default: main.py at the repo root)")
    g.add_argument("--test", metavar="NODEID", help="one test to run instead, as FILE::NAME (a pytest node id or a unittest name)")
    s.add_argument("--pr", metavar="FILE", help="the PR text (default: pr.md at the repo root, else the commit messages base..head)")
    s.add_argument("--python", metavar="P", help="the interpreter that runs the trees (default: as `pyokka run` picks it)")
    s.add_argument("--surface", choices=list(SURFACES), default=None, help="what start opens for the person: auto and vscode record the entry in VS Code (the stops move its Time Machine), page serves the browser page, chat opens nothing (default auto, else $PYOKKA_REVIEW_SURFACE)")
    s.add_argument("--port", type=int, default=None, metavar="P", help="--surface page: the page's port (default $PYOKKA_PORT, else 4777)")
    dir_arg(s)
    s.add_argument("args", nargs="*", metavar="ARGS", help="arguments for the program, after --")

    st = acts.add_parser("stop", help="show one stop: move the person's view there, print it with the explanation, then wait for them")
    st.add_argument("n", type=int, metavar="N", help="the stop's number in the plan (any remaining one: the plan is an agenda the person reorders)")
    st.add_argument("--go-on", dest="go_on", action="store_true", help="the person said next since the last stop; every stop after the first needs it")
    view_args(st)

    a = acts.add_parser("ask", help="an unplanned stop at the first head step on FILE:LINE (the person's question); never needs --go-on")
    a.add_argument("line", metavar="FILE:LINE")
    view_args(a)

    k = acts.add_parser("skip", help="set agenda item N aside with the person's reason; state lists shown, skipped and remaining")
    k.add_argument("n", type=int, metavar="N")
    k.add_argument("--why", metavar="TEXT", help="the reason the person gave")
    dir_arg(k)

    lk = acts.add_parser("look", help="what is X here: a pure expression over the values recorded at the current (or --step) step, without moving anything")
    lk.add_argument("--expr", metavar="EXPR", help="names, operators, subscripts and pure calls (len, sorted, d.get)")
    lk.add_argument("--step", type=int, default=None, metavar="N", help="the step to read (default: the last stop shown or line asked)")
    dir_arg(lk)

    t = acts.add_parser("try", help="a reproduction in the Scratchpad's sandbox (the page's Scratchpad when a page is open on the entry, else headless)")
    g = t.add_mutually_exclusive_group()
    g.add_argument("--code", metavar="FILE", help="a Python file to run; a `result` variable is shown")
    g.add_argument("--expr", metavar="EXPR", help="one expression, run as `result = (EXPR)`")
    t.add_argument("--inputs", metavar="FILE", help="Python assignments bound before the code runs")
    t.add_argument("--mocks", metavar="FILE", help="one Python dict of {target: value}, applied with unittest.mock")
    t.add_argument("--edge", metavar="E", help="the edge candidate this try covers (E1, E2, …)")
    t.add_argument("--title", metavar="T")
    t.add_argument("--port", type=int, default=None, metavar="P", help="the page whose Scratchpad runs it when it is open on the entry (default $PYOKKA_PORT, else 4777; 0 runs headless)")
    dir_arg(t)

    f = acts.add_parser("finding", help="finding add: record a finding; it needs the step that shows it and a reproduction")
    f.add_argument("what", choices=["add"], nargs="?", default="add")
    f.add_argument("--file", metavar="F")
    f.add_argument("--line", type=int, metavar="L")
    f.add_argument("--severity", choices=list(SEVERITIES))
    f.add_argument("--title", metavar="T")
    f.add_argument("--step", type=int, metavar="N", help="a step of head.json in F, within 3 lines of L or in the same function; left out only for a changed line head never ran, with a try as the reproduction")
    f.add_argument("--repro", metavar="ID|CMD", help="a try id, or a shell command run from the repo root whose output must contain --expect")
    f.add_argument("--expect", metavar="TEXT", help="what the reproduction's output contains (required with a command); NAME=VALUE is checked by fix as verify does")
    f.add_argument("--fix", metavar="TEXT", help="the fix, in words")
    dir_arg(f)

    x = acts.add_parser("fix", help="apply a unified diff to a copy of head (DIR/fixed), run the tests there, record it and compare")
    x.add_argument("--patch", metavar="FILE.diff", help="the unified diff (paths as `git diff` writes them, a/ and b/)")
    x.add_argument("--tests", metavar="CMD", help="a shell command run in DIR/fixed")
    dir_arg(x)

    r = acts.add_parser("report", help="re-run every reproduction, then write the review as markdown")
    r.add_argument("--out", metavar="FILE", help="where the markdown goes (default DIR/report.md)")
    r.add_argument("--page", nargs="?", const=True, metavar="FILE", help="also write the review as a code-history page: history.json for render-code-history.cjs, one checkpoint per stop shown or line asked, at FILE or DIR/page.json (never inside the repository)")
    r.add_argument("--tour", nargs="?", const=True, metavar="FILE", help="also write the review as a tour of head.json for render-tour.cjs: the stops shown as its picks, the says as its prose, at FILE or DIR/tour.json (never inside the repository)")
    dir_arg(r)

    c = acts.add_parser("close", help="stop the page server start opened (report does it too); the VS Code recording stays")
    dir_arg(c)

    z = acts.add_parser("state", help="the header, the plan with shown stops marked, findings, tries, and next:")
    dir_arg(z)


__all__ = ["add_review_parser", "HELP"]
