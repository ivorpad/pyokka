"""``pyokka`` / ``python -m pyokka_runtime``: the runner (``serve``), one-off runs, and the commands over a saved run or a live session (``--live``)."""

from __future__ import annotations

import argparse
import os
import sys

RUN_EPILOG = """\
which Python runs the program, first match wins:
  --python PATH        an interpreter, or a venv directory
  $PYOKKA_PYTHON       the same, from the environment
  $VIRTUAL_ENV         the activated virtual environment
  .venv                in the program's directory or a parent, up to the git root
  pyokka's own         when none of the above exists
The runtime is added to that interpreter's PYTHONPATH, so the project's packages import as they
do for the program; it needs Python 3.12 or newer. The first line `run` prints names it.

what the recording leaves out is printed, never dropped:
  a run past --max-steps prints a WARNING with the files that spent the steps and the --exclude
  to rerun with; every command over that run starts with a `note: truncated recording` line.
  A value cut at --max-value-chars ends in …(+N chars); --json gives truncated: true, length: N.
"""


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="pyokka", description="Pyokka runtime: run Python files under the tracer and let an agent step through a saved run.")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("serve", help="NDJSON server on stdin/stdout for the extension host")
    run = sub.add_parser(
        "run",
        help="run one file and print the event stream, or save the run",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=RUN_EPILOG,
    )
    run.add_argument("file")
    run.add_argument("--json", action="store_true", help="NDJSON instead of the pretty listing")
    run.add_argument("--save", metavar="RUN.JSON", help="run through a runner and write the saved run (meta + redacted events)")
    run.add_argument("--library-code", action="store_true", help="instrument third-party packages too (never the stdlib)")
    run.add_argument("--keep", action="store_true", help="with --save: keep the runner alive so `eval`/`expand` can reach the finished run")
    run.add_argument("--no-locals", action="store_true", help="with --save: do not record local variables at every step")
    run.add_argument("--trace-context", type=int, default=None, metavar="STEP", help="evaluate --watch expressions from this step")
    run.add_argument("--watch", action="append", default=[], metavar="EXPR")
    run.add_argument("--auto-log", action="store_true")
    run.add_argument("--mode", choices=["normal", "snaps", "profile"], default="normal")
    run.add_argument("--record-locals", action="store_true")
    run.add_argument("--timeout", type=int, default=0, metavar="MS")
    run.add_argument("--http", choices=["off", "record", "replay"], default="off", help="record every HTTP exchange of the run to <dir>/.pyokka/replay/, or answer from that recording without the network")
    run.add_argument("--instrumented", action="store_true", help="print the instrumented source instead of running")
    run.add_argument("--max-steps", type=int, default=None, metavar="N", help="record at most N steps (default 999,999); past it the program runs on unrecorded and every command over the run says so")
    run.add_argument("--exclude", action="append", default=[], metavar="GLOB", help="leave this code out of the recording: a dotted module (pkg.flash covers pkg.flash.*) or a path glob relative to the file's directory (pkg/flash, */parser.py); repeatable. It runs at full speed and records no steps")
    run.add_argument("--only", action="append", default=[], metavar="GLOB", help="record only these modules or paths (same forms as --exclude), library ones included; the program file is always recorded; repeatable")
    run.add_argument("--max-value-chars", type=int, default=None, metavar="N", help="characters one recorded value keeps (default 120 for a local, 200 for a logged value); 0 = no limit up to the 1,000,000 ceiling. A cut value ends in …(+N chars)")
    run.add_argument("--python", metavar="PATH", help="the interpreter that runs the program (a venv directory works too); see below for the default")
    run.add_argument("argv", nargs="*", help="arguments for the program (after --)")
    cache = sub.add_parser("cache", help="the cache of instrumented library files ($PYOKKA_HOME/cache, default ~/.pyokka/cache, or PYOKKA_CACHE_DIR): directory, entries, size")
    cache.add_argument("--clear", action="store_true", help="remove every entry; the next run rewrites what it needs")
    cache.add_argument("--json", action="store_true", help="print the raw JSON shape")
    child = sub.add_parser("_child")
    child.add_argument("--port", type=int, required=True)
    child.add_argument("--token", required=True)
    keep = sub.add_parser("_keep")
    keep.add_argument("--socket", required=True)
    keep.add_argument("--idle", type=float, default=None)

    from .agent.commands import COMMANDS, add_commands

    add_commands(sub)
    args = parser.parse_args(argv)
    if args.command == "serve":
        from .runner import Runner

        return Runner().serve()
    if args.command == "_child":
        from .child import spawned_child_main

        spawned_child_main(args.port, args.token)
        return 0
    if args.command == "_keep":
        from .agent.keep import DEFAULT_IDLE_S, keep_main

        return keep_main(["--socket", args.socket, "--idle", str(args.idle if args.idle is not None else DEFAULT_IDLE_S)])
    if args.command == "cache":
        from .cli import cache_command

        return cache_command(args)
    if args.command in COMMANDS:
        from .agent.commands import dispatch

        return dispatch(args)
    interp = None
    if not args.instrumented:
        from .agent.interpreter import choose, probe
        from .agent.source import AgentError

        try:
            interp = probe(choose(args.file, args.python))
        except AgentError as exc:
            sys.stderr.write("error: %s\n%s\n" % (exc.message, exc.hint or ""))
            return 2
        if not args.save and not interp.is_own and not os.environ.get("PYOKKA_REEXEC"):
            # the in-process run has to happen inside the program's interpreter: start this command again there
            from .agent.link import runner_env

            env = runner_env()
            env["PYOKKA_REEXEC"] = interp.source
            sys.stdout.flush()
            os.execve(interp.path, [interp.path, "-m", "pyokka_runtime", *(argv if argv is not None else sys.argv[1:])], env)
        if os.environ.get("PYOKKA_REEXEC"):
            interp.source = os.environ["PYOKKA_REEXEC"]
        (sys.stderr if args.json and not args.save else sys.stdout).write(interp.line() + "\n")
    recording = {
        "maxTraceSteps": args.max_steps,
        "exclude": list(args.exclude or []),
        "only": list(args.only or []),
        "maxValueChars": args.max_value_chars,
    }
    if args.max_steps is not None and args.max_steps < 1:
        sys.stderr.write("error: --max-steps must be 1 or more, got %d\n" % args.max_steps)
        return 2
    if args.save:
        from .agent.save import save_run

        try:
            meta = save_run(args.file, args.save, library_code=args.library_code, keep=args.keep, record_locals=not args.no_locals, auto_log=args.auto_log, timeout_ms=int(args.timeout or 0), argv=list(args.argv or []), http=args.http, progress=lambda s: print(s), recording=recording, python=interp)
        except (RuntimeError, OSError) as exc:
            sys.stderr.write("error: %s\n" % exc)
            return 2
        code = meta.get("exitCode")
        return int(code) if isinstance(code, int) else 1
    from .cli import run_file

    return run_file(args, recording)


if __name__ == "__main__":
    sys.exit(main())
