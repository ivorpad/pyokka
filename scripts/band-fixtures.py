#!/usr/bin/env python3
"""Capture the CLI JSON the Pyokka band reads, as test fixtures.

Runs the programs in claude-plugin/pyokka-band/tests/programs/ with the pyokka CLI from a
temporary folder, asks it what the band asks a live session (`context --json`,
`exceptions --json`, `origin --json`, `suspects --json`), and writes the answers, with the
folder renamed to /work, to claude-plugin/pyokka-band/tests/fixtures.ts.

    python3 scripts/band-fixtures.py --pyokka "uv run --quiet --directory python python -m pyokka_runtime"
    python3 scripts/band-fixtures.py                       # pyokka on PATH
    python3 scripts/band-fixtures.py --suspects "uv run --directory ../bugs/python python -m pyokka_runtime"

`--suspects` names a CLI that has `pyokka suspects`, when the one in `--pyokka` lacks it. A verb
the CLI lacks (`suspects`, `origin`) keeps the fixture already in fixtures.ts.

A debug pause without a recording needs VS Code, so its fixtures (`PAUSED_*`) come from the e2e
spec test/e2e/debug-band.test.js, which writes what it read to the file PYOKKA_BAND_CAPTURE names:

    PYOKKA_BAND_CAPTURE=/tmp/band-live.json ./node_modules/.bin/vscode-test   # that spec
    python3 scripts/band-fixtures.py --live /tmp/band-live.json

Without `--live` the PAUSED_* fixtures already in fixtures.ts are kept.
"""

import argparse
import json
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PLUGIN = ROOT / "claude-plugin" / "pyokka-band"
PROGRAMS = PLUGIN / "tests" / "programs"
OUT = PLUGIN / "tests" / "fixtures.ts"
WORK = "/work"


def cli(command: list[str], *args: str, cwd: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run([*command, *args], cwd=cwd, capture_output=True, text=True)


def previous_blocks() -> dict[str, str]:
    """The fixtures already in fixtures.ts, by name, each with its comment line."""
    if not OUT.exists():
        return {}
    blocks = {}
    for block in OUT.read_text().split("\n\n"):
        found = re.search(r"^export const (\w+) = ", block, re.M)
        if found and block.startswith("// "):
            blocks[found.group(1)] = block.strip("\n") + "\n"
    return blocks


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pyokka", default="pyokka")
    parser.add_argument("--suspects", default="")
    parser.add_argument("--live", default="", help="the JSON test/e2e/debug-band.test.js wrote (PYOKKA_BAND_CAPTURE)")
    options = parser.parse_args()
    captured = json.loads(Path(options.live).read_text()) if options.live else {}
    live_dir = str(captured.pop("dir", ""))
    pyokka = shlex.split(options.pyokka)
    suspects = shlex.split(options.suspects) if options.suspects else pyokka
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp).resolve()
        for program in PROGRAMS.glob("*.py"):
            shutil.copy(program, work / program.name)
        stale = work / "stale"
        stale.mkdir()
        shutil.copy(PROGRAMS / "invoices.py", stale / "invoices.py")

        def run(name: str, folder: Path = work) -> str:
            saved = folder / f"{Path(name).stem}.json"
            done = cli(pyokka, "run", str(folder / name), "--save", str(saved), "--record-locals", cwd=folder)
            if not saved.exists():
                sys.exit(f"run {name} failed:\n{done.stderr}")
            return str(saved)

        invoices = run("invoices.py")
        crash = run("crash.py")
        old = run("invoices.py", stale)
        (stale / "invoices.py").write_text((stale / "invoices.py").read_text() + "# edited after the recording\n")

        def live(name: str) -> object | None:
            value = captured.get(name)
            return json.loads(json.dumps(value).replace(live_dir, WORK)) if value is not None and live_dir else None

        def ask(*args: str, command: list[str] = pyokka) -> object | None:
            done = cli(command, *args, "--json", cwd=work)
            return json.loads(done.stdout) if done.returncode == 0 else None

        # name: (comment, value, whether every CLI the band supports has the verb)
        wanted = {
            "CONTEXT_64": ("`context --json` at step 64 of invoices.py: the TypeError that subtotal swallows",
                           ask("context", invoices, "64"), True),
            "CONTEXT_29": ("`context --json` at step 29 of invoices.py: parse_price returns the text '1,299.00'",
                           ask("context", invoices, "29"), True),
            "CONTEXT_STALE": ("`context --json` at step 64 after invoices.py changed on disk",
                              ask("context", old, "64"), True),
            "EXCEPTIONS_CAUGHT": ("`exceptions --json` of invoices.py: one TypeError, caught",
                                  ask("exceptions", invoices), True),
            "EXCEPTIONS_UNCAUGHT": ("`exceptions --json` of crash.py: one KeyError that ends the run",
                                    ask("exceptions", crash), True),
            "ORIGIN_64": ("`origin --json` at step 64 of invoices.py: where the text '1,299.00' came from",
                          ask("origin", invoices, "64"), False),
            "ORIGIN_UNKNOWN": ("`origin --json` at step 64 of invoices.py for `items`: a list filled in place, root not known",
                               ask("origin", invoices, "64", "items"), False),
            "SUSPECTS": ("`suspects --json` of invoices.py (worktree-bugs, WIP)",
                         ask("suspects", invoices, command=suspects), False),
            "PAUSED_SUBTOTAL": ("`context --live --json` at a plain debug pause (no recording): the breakpoint on invoices.py:34, Ana's call",
                                live("PAUSED_SUBTOTAL"), False),
            "PAUSED_OVER": ("`step --live --over --json` from there: the breakpoint again, Ben's call with the text '1,299.00'",
                            live("PAUSED_OVER"), False),
            "PAUSED_CRASH": ("`context --live --json` at a plain debug pause on crash.py's uncaught KeyError",
                             live("PAUSED_CRASH"), False),
        }

    def text(value: object) -> str:
        return json.dumps(value, indent=2, ensure_ascii=False).replace(str(work), WORK)

    before = previous_blocks()
    parts = [
        "// Written by scripts/band-fixtures.py from what the pyokka CLI printed. Do not edit by hand:",
        "// run the script again when the CLI's JSON changes. Paths read /work/<file>.",
        "",
    ]
    written, kept = [], []
    for name, (about, value, required) in wanted.items():
        if value is not None:
            parts += [f"// {about}", f"export const {name} = {text(value)}", ""]
            written.append(name)
        elif name in before and not required:
            parts += [before[name]]
            kept.append(name)
        else:
            sys.exit(f"{name}: the CLI gave no JSON, and fixtures.ts has none to keep")
    for program in sorted(PROGRAMS.glob("*.py")):
        const = program.stem.upper() + "_SOURCE"
        parts += [f"// {program.name} as recorded", f"export const {const} = {json.dumps(program.read_text())}", ""]
    OUT.write_text("\n".join(parts))
    print(f"wrote {OUT.relative_to(ROOT)}: {', '.join(written)}" + (f"; kept {', '.join(kept)}" if kept else ""))


if __name__ == "__main__":
    main()
