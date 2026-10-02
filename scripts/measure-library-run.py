#!/usr/bin/env python3
"""Time a run that imports openai under a venv that has it, in three library-code configurations.

Run from python/: `PYOKKA_LIBDIAG_PYTHON=/path/to/venv/bin/python uv run --no-project python
../scripts/measure-library-run.py`. No network: the client is built
with a fake key and never called. Library configurations run twice against a fresh cache directory: cold (every
library file rewritten and stored) and warm (loaded from the cache).
"""
import json, os, subprocess, sys, time, collections, tempfile, shutil
PY = os.environ.get('PYOKKA_LIBDIAG_PYTHON') or sys.exit('set PYOKKA_LIBDIAG_PYTHON to a python whose venv has openai')
TMP = tempfile.mkdtemp(prefix='pyokka-measure-')
CACHE = tempfile.mkdtemp(prefix='pyokka-cache-', dir=TMP)
scratch = tempfile.NamedTemporaryFile('w', suffix='.py', delete=False, dir=TMP); scratch.write('import openai\nclient = openai.OpenAI(api_key="x")\nn = 1\n'); scratch.close()
def run(label, cfg):
    p = subprocess.Popen([PY, '-m', 'pyokka_runtime', 'serve'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, cwd=os.getcwd(), env={**os.environ, 'PYOKKA_SPAWN': '0', 'PYOKKA_CACHE_DIR': CACHE})
    def send(m): p.stdin.write((json.dumps(m) + '\n').encode()); p.stdin.flush()
    send({'type': 'hello', 'id': 1, 'version': '1'}); p.stdout.readline()
    t0 = time.perf_counter(); first = None
    send({'type': 'run', 'id': 2, 'runId': 'r', 'file': {'path': scratch.name, 'displayName': 's.py', 'content': open(scratch.name).read()}, 'workspaceRoot': TMP, 'cwd': TMP, 'argv': [], 'env': {}, 'projectFiles': [], 'config': {'timeoutMs': 300000, **cfg}, 'markers': [], 'expressionsToEvaluate': {}, 'watch': [], 'mode': 'normal'})
    counts = collections.Counter(); byts = collections.Counter(); fin = None
    while True:
        line = p.stdout.readline()
        if not line: break
        ev = json.loads(line); t = ev.get('type'); counts[t] += 1; byts[t] += len(line)
        if t == 'file.instrumented' and first is None: first = time.perf_counter() - t0
        if t == 'run.finished': fin = ev; break
    dt = time.perf_counter() - t0
    send({'type': 'shutdown', 'id': 3}); p.wait(timeout=10)
    print(f"{label:28s} wall={dt:6.2f}s first_file={first or 0:5.2f}s steps={fin.get('stepCount') if fin else '?':>8} exit={fin.get('exitCode') if fin else '?'} timedOut={fin.get('timedOut') if fin else '?'}")
    print('   events:', {k: counts[k] for k in ('file.instrumented', 'trace', 'log', 'error', 'coverage')}, ' MB:', {k: round(byts[k]/1e6, 1) for k in ('file.instrumented', 'trace', 'coverage')})
run('baseline (no library code)', {})
run('[openai] cold cache', {'libraryCode': True, 'libraryPackages': ['openai']})
run('[openai] warm cache', {'libraryCode': True, 'libraryPackages': ['openai']})
run('all packages cold cache', {'libraryCode': True})
run('all packages warm cache', {'libraryCode': True})
size = sum(os.path.getsize(os.path.join(CACHE, f)) for f in os.listdir(CACHE))
print(f"cache: {len(os.listdir(CACHE))} entries, {size/1e6:.1f} MB")
os.unlink(scratch.name)
shutil.rmtree(CACHE, ignore_errors=True)
