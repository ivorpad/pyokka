// Minimal stand-in for `python -m pyokka_runtime serve`, driven by env FAKE_MODE.
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const mode = process.env.FAKE_MODE || 'normal';
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  switch (msg.type) {
    case 'hello':
      send({ type: 'ready', id: msg.id, pythonVersion: '3.12.0', executable: '/fake/python', platform: 'fake', capabilities: ['fork'] });
      break;
    case 'run': {
      // PKW_FAKE_DIRS: write the run's workspace root and working directory there, for the --cwd tests
      if (process.env.PKW_FAKE_DIRS) require('node:fs').writeFileSync(process.env.PKW_FAKE_DIRS, JSON.stringify({ workspaceRoot: msg.workspaceRoot, cwd: msg.cwd }));
      send({ type: 'ok', id: msg.id });
      send({ type: 'run.started', runId: msg.runId, seq: 1, pid: 42 });
      // FAKE_IMPORT: the run also instrumented this imported file
      if (process.env.FAKE_IMPORT) send({ type: 'file.instrumented', runId: msg.runId, seq: 1, fileId: 2, path: process.env.FAKE_IMPORT, rangeBase: 0, ranges: [], statements: [], functions: [], magic: [] });
      if (msg.config && msg.config.debug) {
        // a live debug run: pause at the first statement until `debug continue`
        send({ type: 'debug.paused', runId: msg.runId, seq: 2, step: 0, rid: 0, fileId: 1, line: 1, scopeId: 0, depth: 0, reason: 'start', stack: [{ frameId: 0, name: '<module>', fileId: 1, line: 1 }] });
        break;
      }
      if (msg.mode === 'profile') {
        // a flat profile as the Python runtime writes it: `add` 2 ms of samples
        const file = require('node:path').join(require('node:os').tmpdir(), `fake-${process.pid}-${Date.now()}.cpuprofile`);
        const nodes = [{ id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: -1 }, hitCount: 0, children: [2] }, { id: 2, callFrame: { functionName: 'add', url: 'file://' + msg.file.path, lineNumber: 0 }, hitCount: 2, children: [], callCount: 4, totalTime: 2.5 }];
        require('node:fs').writeFileSync(file, JSON.stringify({ nodes, startTime: 0, endTime: 2000, samples: [2, 2], timeDeltas: [1000, 1000] }));
        send({ type: 'run.finished', runId: msg.runId, seq: 2, exitCode: 0, durationMs: 2, timedOut: false, stopped: false, stepCount: 0, logCount: 0, profile: { path: file } });
        break;
      }
      // a watch is answered at the step the run was asked to record around
      for (const w of msg.watch || []) send({ type: 'watch', runId: msg.runId, seq: 2, watchId: w.id, step: (msg.traceContext && msg.traceContext.step) || 0, valueBag: { runtimeKey: 'w', data: { type: 'str', value: w.exp, id: 'w', queryPath: [] } } });
      // deliberately split a message across two writes to exercise framing
      const log = JSON.stringify({ type: 'log', runId: msg.runId, seq: 2, logId: 'l1', kind: 'log', fileId: 1, rid: 0, hit: 1, step: 0, text: 'ok', runtimeKey: '0' }) + '\n';
      process.stdout.write(log.slice(0, 20));
      setTimeout(() => {
        process.stdout.write(log.slice(20));
        if (mode === 'crash') process.exit(3);
        send({ type: 'run.finished', runId: msg.runId, seq: 3, exitCode: 0, durationMs: 1, timedOut: false, stopped: false, stepCount: 1, logCount: 1 });
      }, 10);
      break;
    }
    case 'expand':
      send({ type: 'error', id: msg.id, message: 'no such value' });
      break;
    case 'source':
      send({ type: 'source', id: msg.id, fileId: msg.fileId, instrumentedSource: msg.fileId === 2 ? '_pk_s(0)' : null });
      break;
    case 'bindings':
      if (msg.source === 'def (:') send({ type: 'error', id: msg.id, message: 'SyntaxError: invalid syntax' });
      else send({ type: 'bindings', id: msg.id, statements: [{ line: 1, col: 0, assigns: ['x'], reads: [] }] });
      break;
    case 'debug':
      send({ type: 'debug.result', id: msg.id, ...(msg.action === 'locals' ? { locals: [{ name: 'x', text: '1' }] } : {}) });
      if (msg.action === 'continue') send({ type: 'run.finished', runId: msg.runId, seq: 9, exitCode: 0, durationMs: 1, timedOut: false, stopped: false, stepCount: 0, logCount: 0 });
      break;
    case 'stop':
      send({ type: 'ok', id: msg.id });
      break;
    case 'shutdown':
      process.exit(0);
      break;
    default:
      send({ type: 'runner.error', message: `unknown request ${msg.type}` });
  }
});
