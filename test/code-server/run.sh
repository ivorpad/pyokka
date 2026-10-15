#!/bin/bash
# The e2e specs in a real VS Code where @vscode/test-electron cannot download one (a cloud container
# whose network only reaches npm): code-server from npm, opened in Chromium, runs the mocha specs
# inside its extension host through a small driver extension (driver/), and prints PASS / FAIL.
#
#   test/code-server/run.sh WORKSPACE SPECS EXT_ID VSIX...
#   test/code-server/run.sh /tmp/ws test/e2e/features.test.js ivor.pyokka pyokka-0.4.0.vsix
#
# SPECS is comma-separated absolute or repository paths; EXT_ID is $E2E_EXTENSION for the specs;
# every VSIX is installed. E2E_GREP filters tests, SETTINGS adds ',"key":value' to settings.json.
# Needs Chromium (PLAYWRIGHT_BROWSERS_PATH or CHROMIUM) and Xvfb-free headless; libkrb5-dev to
# build code-server's native modules once. Tools are cached in $CS_CACHE (~/.cache/pyokka-code-server).
set -u
HERE=$(cd "$(dirname "$0")" && pwd); REPO=$(cd "$HERE/../.." && pwd)
CACHE=${CS_CACHE:-$HOME/.cache/pyokka-code-server}
WS=$1; SPECS=$2; EXTID=$3; shift 3
mkdir -p "$CACHE"
if [ ! -x "$CACHE/node_modules/node-linux-x64/bin/node" ]; then (cd "$CACHE" && npm init -y >/dev/null && npm install node-linux-x64@24 >/dev/null) || exit 1; fi
export PATH=$CACHE/node_modules/node-linux-x64/bin:$PATH   # code-server 4.141 wants Node 24
if [ ! -x "$CACHE/node_modules/.bin/code-server" ]; then (cd "$CACHE" && npm install code-server@4.141.0 playwright-core@1.55.0 mocha@10 >/dev/null) || exit 1; fi
CS=$CACHE/node_modules/.bin/code-server
RUN=$(mktemp -d /tmp/cs-run-XXXX); mkdir -p "$RUN/ext" "$RUN/data/User"
for v in "$@"; do $CS --extensions-dir "$RUN/ext" --user-data-dir "$RUN/data" --install-extension "$v" >/dev/null 2>&1 || echo "install failed: $v"; done
cp -r "$HERE/driver" "$RUN/ext/test.e2e-driver-0.0.1"
node -e '
const fs = require("fs"); const dir = process.argv[1]; const f = dir + "/extensions.json";
const j = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f)) : [];
j.push({ identifier: { id: "test.e2e-driver" }, version: "0.0.1", location: { $mid: 1, path: dir + "/test.e2e-driver-0.0.1", scheme: "file" }, relativeLocation: "test.e2e-driver-0.0.1" });
fs.writeFileSync(f, JSON.stringify(j));' "$RUN/ext"
echo "{\"security.workspace.trust.enabled\":false,\"workbench.startupEditor\":\"none\"${SETTINGS:-}}" > "$RUN/data/User/settings.json"
abs() { case "$1" in /*) echo "$1";; *) echo "$REPO/$1";; esac; }
SPECS=$(IFS=,; for s in $SPECS; do printf '%s,' "$(abs "$s")"; done); SPECS=${SPECS%,}
export E2E_RESULT=$RUN/result.json E2E_SPECS=$SPECS E2E_MOCHA=$CACHE/node_modules/mocha E2E_EXTENSION=$EXTID
export PYOKKA_E2E=1 PYOKKA_HOME=$(mktemp -d /tmp/pk-XXXX)
PORT=$((20000 + RANDOM % 20000))
$CS --auth none --bind-addr 127.0.0.1:$PORT --extensions-dir "$RUN/ext" --user-data-dir "$RUN/data" --disable-telemetry --disable-workspace-trust "$WS" > "$RUN/server.log" 2>&1 &
SP=$!
for _ in $(seq 60); do curl -s -o /dev/null "http://127.0.0.1:$PORT/healthz" && break; sleep 1; done
NODE_PATH=$CACHE/node_modules node "$HERE/open.mjs" "http://127.0.0.1:$PORT/?folder=$WS" "$E2E_RESULT" "$RUN/shot.png"
kill $SP 2>/dev/null
echo "logs and a screenshot: $RUN"
cat "$E2E_RESULT.log" 2>/dev/null
cat "$E2E_RESULT" 2>/dev/null; echo
grep -q '"failures":0' "$E2E_RESULT" 2>/dev/null
