// Runs the mocha specs named in $E2E_SPECS inside this extension host and writes the result to $E2E_RESULT.
const fs = require('fs');
exports.activate = () => {
  const out = process.env.E2E_RESULT;
  const log = (s) => fs.appendFileSync(out + '.log', s + '\n');
  setTimeout(() => {
    try {
      const Mocha = require(process.env.E2E_MOCHA);
      const mocha = new Mocha({ ui: 'bdd', timeout: 180000, reporter: 'spec', grep: process.env.E2E_GREP || undefined });
      for (const f of process.env.E2E_SPECS.split(',')) mocha.addFile(f);
      const runner = mocha.run((failures) => fs.writeFileSync(out, JSON.stringify({ failures })));
      runner.on('pass', (t) => log(`PASS ${t.fullTitle()} (${t.duration}ms)`));
      runner.on('fail', (t, err) => log(`FAIL ${t.fullTitle()}\n  ${String(err && err.stack || err).split('\n').slice(0, 6).join('\n  ')}`));
    } catch (e) { fs.writeFileSync(out, JSON.stringify({ error: String(e && e.stack || e) })); }
  }, 3000);
};
