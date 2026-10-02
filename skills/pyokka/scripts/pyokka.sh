#!/bin/sh
# The pyokka CLI. In a Pyokka checkout (skills/pyokka/scripts -> ../../../python) it runs that source;
# a copy the extension installed has no checkout next to it, so it runs the `pyokka` the extension
# keeps on PATH or in ~/.local/bin. Works through a symlinked install.
here=$(cd "$(dirname "$(realpath "$0")")" && pwd)
if [ -d "$here/../../../python/pyokka_runtime" ]; then
  PYTHONPATH="$here/../../../python${PYTHONPATH:+:$PYTHONPATH}" exec python3 -m pyokka_runtime "$@"
fi
if command -v pyokka >/dev/null 2>&1; then exec pyokka "$@"; fi
if [ -x "$HOME/.local/bin/pyokka" ]; then exec "$HOME/.local/bin/pyokka" "$@"; fi
echo "pyokka.sh: no Pyokka checkout next to this skill and no pyokka on PATH or in ~/.local/bin. Turn on pyokka.agentAccess in VS Code so the extension installs it." >&2
exit 127
