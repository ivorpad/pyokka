// Opens the code-server workbench in Chromium and keeps it open until the e2e result file appears
// (the extension host runs only while a client is connected). Screenshots the window as it goes.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const { chromium } = createRequire(path.join(process.env.NODE_PATH ?? '.', 'x'))('playwright-core');
const [url, result, shot] = process.argv.slice(2);
const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
const found = fs.existsSync(browsers) ? fs.readdirSync(browsers).filter((d) => /^chromium-\d+$/.test(d)).sort().pop() : undefined;
const exe = process.env.CHROMIUM ?? (found ? path.join(browsers, found, 'chrome-linux', 'chrome') : undefined);
const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('console', (m) => { if (m.type() === 'error') console.log('[page]', m.text().slice(0, 300)); });
await page.goto(url);
const deadline = Date.now() + 15 * 60_000;
let n = 0;
while (!fs.existsSync(result) && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 2000));
  if (shot && ++n % 15 === 0) await page.screenshot({ path: shot }).catch(() => {});
}
if (shot) await page.screenshot({ path: shot }).catch(() => {});
await browser.close();
