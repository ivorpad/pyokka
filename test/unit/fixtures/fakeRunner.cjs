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
      send({ type: 'ok', id: msg.id });
      send({ type: 'run.started', runId: msg.runId, seq: 1, pid: 42 });
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
