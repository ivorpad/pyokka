// End-to-end: HTTP record and replay (config.http) on a scratch file that talks to a local server.
// The server counts requests, so a GET answered by the network differs from one answered by the recording.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vscode = require('vscode');

/** The scratch program: stdlib only, the server's port baked in, values derived from both responses. */
const program = (port) =>
  [
    'import json',
    'import urllib.request',
    '',
    `BASE = "http://127.0.0.1:${port}"`,
    'opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))',
    '',
    'with opener.open(BASE + "/hello") as r:',
    '    data = json.loads(r.read())',
    'print(data)',
    '',
    'req = urllib.request.Request(BASE + "/echo", data=json.dumps({"name": "pyokka"}).encode(), headers={"Content-Type": "application/json"})',
    'with opener.open(req) as r:',
    '    echoed = json.loads(r.read())',
    'print(echoed)',
    '',
    'n = data["n"]',
    'total = n * 100 + len(echoed["name"])',
    'print(total)',
    '',
  ].join('\n');

describe('Pyokka HTTP record and replay', function () {
  let api, session, doc, editor;
  let server, port, file, dotDir, replayDir;
  let hits = 0; // requests the server answered
  const sockets = new Set();
  let recordedTexts; // what the record run logged

  const logTexts = () => session.state.entries.filter((e) => e.kind === 'log').map((e) => e.text);

  /** Re-execute the active session and return its `run.finished`. */
  const reexecute = async () => {
    editor = await vscode.window.showTextDocument(doc);
    const next = api.waitForNextRun(session, 60_000);
    await vscode.commands.executeCommand('pyokka.reexecute');
    await next;
    return session.state.finished;
  };

  /** Close the server and every open socket: from here on no request can succeed. */
  const stopServer = () =>
    new Promise((resolve) => {
      const s = server;
      server = undefined;
      if (!s) return resolve();
      s.close(() => resolve());
      for (const sock of sockets) sock.destroy();
      sockets.clear();
    });

  before(async () => {
    const ext = vscode.extensions.getExtension('ivor.pyokka');
    assert.ok(ext, 'extension found');
    api = await ext.activate();

    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        hits += 1;
        if (req.method === 'GET' && req.url === '/hello') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ greeting: 'hello', n: hits }));
        } else if (req.method === 'POST' && req.url === '/echo') {
          res.writeHead(200, { 'content-type': req.headers['content-type'] || 'application/octet-stream' });
          res.end(body);
        } else {
          res.writeHead(404, { 'content-type': 'text/plain' });
          res.end('nope');
        }
      });
    });
    server.on('connection', (sock) => {
      sockets.add(sock);
      sock.on('close', () => sockets.delete(sock));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;

    const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
    file = path.join(root, 'replay_scratch.py');
    dotDir = path.join(root, '.pyokka');
    replayDir = path.join(dotDir, 'replay');
    assert.ok(!fs.existsSync(replayDir), 'the example workspace has no recording of its own');
    fs.writeFileSync(file, program(port));
    doc = await vscode.workspace.openTextDocument(file);
    editor = await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('workbench.action.closePanel');
    await vscode.commands.executeCommand('pyokka.startOnCurrentFile');
    session = api.manager.sessionForDocument(doc);
    assert.ok(session, 'session created');
    await api.waitForIdle(session, 60_000);
  });

  after(async () => {
    if (session) api.manager.stopAll();
    if (doc) {
      // the document is dirty (edited, never saved): revert instead of prompting to save
      await vscode.window.showTextDocument(doc);
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    }
    if (file) {
      fs.rmSync(file, { force: true });
      api.manager.recentFiles.remove(api.manager.recentFiles.list().filter((e) => e.path === file).map((e) => e.id));
    }
    if (replayDir) {
      fs.rmSync(replayDir, { recursive: true, force: true });
      if (fs.existsSync(dotDir) && fs.readdirSync(dotDir).length === 0) fs.rmdirSync(dotDir);
    }
    await stopServer();
  });

  it('records both exchanges of an explicit run into the workspace replay file', async () => {
    assert.equal(session.http, 'off', 'off by default');
    assert.equal(session.status, 'done', 'the start run went through the network');
    const before = hits;
    assert.ok(before >= 2, `the start run reached the server: ${before} requests`);

    session.setRunMode('onDemand');
    session.setHttp('record');
    assert.equal(session.running, false, 'changing the HTTP mode never runs by itself');

    const finished = await reexecute();
    assert.equal(session.status, 'done', `record run status; errors: ${JSON.stringify(session.state.errors.map((e) => e.message))}`);
    assert.equal(finished.replayed, undefined);
    assert.deepEqual(
      { mode: finished.http.mode, recorded: finished.http.recorded, served: finished.http.served, misses: finished.http.misses },
      { mode: 'record', recorded: 2, served: 0, misses: 0 },
    );
    assert.equal(hits, before + 2, 'a record run lets both requests through');

    // the recording: <workspaceRoot>/.pyokka/replay/<first 16 hex of sha256(realpath)>.jsonl
    const hash = crypto.createHash('sha256').update(fs.realpathSync(file)).digest('hex').slice(0, 16);
    assert.equal(finished.http.file, path.join(replayDir, `${hash}.jsonl`));
    assert.ok(fs.existsSync(finished.http.file), 'recording written');
    const lines = fs.readFileSync(finished.http.file, 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 3, 'a header line and one line per exchange');
    assert.equal(lines[0].pyokka, 'http');
    assert.equal(lines[0].version, 1);
    assert.equal(lines[0].file, fs.realpathSync(file));
    assert.equal(lines[1].client, 'http.client');
    assert.equal(lines[1].n, 1);
    assert.equal(lines[1].request.method, 'GET');
    assert.equal(lines[1].request.url, `http://127.0.0.1:${port}/hello`);
    assert.equal(lines[1].response.status, 200);
    assert.deepEqual(JSON.parse(lines[1].response.body), { greeting: 'hello', n: before + 1 });
    assert.equal(lines[2].client, 'http.client');
    assert.equal(lines[2].request.method, 'POST');
    assert.equal(lines[2].request.body, '{"name": "pyokka"}');
    assert.equal(lines[2].response.body, '{"name": "pyokka"}');

    recordedTexts = logTexts();
    assert.equal(recordedTexts.length, 3, `three prints logged: ${JSON.stringify(recordedTexts)}`);
    assert.equal(recordedTexts[0], `{'greeting': 'hello', 'n': ${before + 1}}`);
    assert.equal(recordedTexts[1], "{'name': 'pyokka'}");
    assert.equal(recordedTexts[2], String((before + 1) * 100 + 'pyokka'.length));
  });

  it('replays an edited file from the recording with the server gone and the same values', async () => {
    await stopServer();
    const before = hits;
    editor = await vscode.window.showTextDocument(doc);
    await editor.edit((b) => b.insert(new vscode.Position(0, 0), '# edited after recording, never saved\n'));
    assert.equal(session.running, false, 'On Demand: the edit did not run');
    session.setHttp('replay');

    const finished = await reexecute();
    assert.equal(session.status, 'done', `replay run status; errors: ${JSON.stringify(session.state.errors.map((e) => e.message))}`);
    assert.equal(finished.replayed, true);
    assert.equal(finished.exitCode, 0);
    assert.deepEqual(
      { mode: finished.http.mode, recorded: finished.http.recorded, served: finished.http.served, misses: finished.http.misses },
      { mode: 'replay', recorded: 0, served: 2, misses: 0 },
    );
    assert.match(finished.http.file, /\/\.pyokka\/replay\/[0-9a-f]{16}\.jsonl$/);
    assert.equal(hits, before, 'nothing reached the server');
    // the counter the server would have moved on is the recorded one
    assert.deepEqual(logTexts(), recordedTexts);
  });

  it('reports a request without a recording as a miss and a ConnectionError in the program', async () => {
    const before = hits;
    editor = await vscode.window.showTextDocument(doc);
    const end = doc.positionAt(doc.getText().length);
    await editor.edit((b) => b.insert(end, 'with opener.open(BASE + "/other") as r:\n    other = r.read()\n'));
    assert.equal(session.running, false, 'On Demand: the edit did not run');

    const finished = await reexecute();
    assert.equal(session.status, 'failed');
    assert.equal(finished.replayed, true);
    assert.deepEqual(
      { mode: finished.http.mode, recorded: finished.http.recorded, served: finished.http.served, misses: finished.http.misses },
      { mode: 'replay', recorded: 0, served: 2, misses: 1 },
    );
    assert.equal(hits, before, 'a miss never falls back to the network');
    const err = session.state.errors.find((e) => !e.handled);
    assert.ok(err, `an unhandled error was reported: ${JSON.stringify(session.state.errors)}`);
    assert.equal(err.errorType, 'ConnectionError');
    assert.equal(err.message, `pyokka replay: no recorded response for GET http://127.0.0.1:${port}/other`);
    // the two recorded exchanges were still served before the miss
    assert.deepEqual(logTexts(), recordedTexts);
  });
});
