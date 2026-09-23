// Browser smoke test: builds nothing, serves dist/ with `vite preview`, and walks the demo loop
// through every step in Chromium. Fails on any page error or a number that isn't what it should be.
//   npm run build && npm run e2e
// Set CHROMIUM_PATH to use a Chromium that isn't Playwright's own.
import { chromium } from 'playwright';
import { preview } from 'vite';
import assert from 'node:assert/strict';

const server = await preview({ preview: { port: 4174, strictPort: true } });
const url = 'http://localhost:4174/beat-mapper/';
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const text = (id) => page.$eval('#' + id, (e) => e.textContent);
  const step = async (name, fn) => { process.stdout.write(`  ${name} … `); await fn(); console.log('ok'); };

  // Web fonts are cosmetic and need the network; serve an empty stylesheet so the test runs offline.
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await page.goto(url);
  await step('demo loop is analysed', async () => {
    await page.click('#demoBtn');
    await page.waitForFunction(() => document.getElementById('mCount').textContent !== '' && document.getElementById('busy').hidden, null, { timeout: 30000 });
    assert.equal(await text('mCount'), '128');
  });
  await step('a double-click adds a marker, undo takes it away', async () => {
    const b = await (await page.$('#cv')).boundingBox();
    for (let i = 0; i < 4; i++) await page.keyboard.press('+');
    // somewhere in the edit half that isn't on a marker (the cursor says)
    let x = 300;
    for (; x < 1200; x += 3) {
      await page.mouse.move(b.x + x, b.y + 80);
      if ((await page.$eval('#cv', (e) => e.style.cursor)) === 'default') break;
    }
    await page.mouse.dblclick(b.x + x, b.y + 80);
    assert.equal(await text('mCount'), '129');
    await page.keyboard.press('Control+z');
    assert.equal(await text('mCount'), '128');
  });
  await step('Beats: bar 1, then auto-map', async () => {
    await page.keyboard.press('2');
    assert.equal(await text('aCount'), '1');
    await page.keyboard.press('m');
    assert.equal(await text('aCount'), '64');
    assert.match(await text('sum'), /^17 bars · avg 98\.16/);
  });
  await step('Export: MIDI file downloads', async () => {
    await page.keyboard.press('3');
    assert.match(await text('expInfo'), /tempo changes/);
    const [d] = await Promise.all([page.waitForEvent('download'), page.click('#saveBtn')]);
    assert.equal(d.suggestedFilename(), 'drifting-drum-loop-tempo-map.mid');
  });
  await step('Slice: one slice per transient', async () => {
    await page.keyboard.press('4');
    assert.equal(await text('slCount'), '128/128');
  });
  await step('Groove: kick, snare and hats found and measured', async () => {
    await page.keyboard.press('5');
    await page.waitForFunction(() => document.getElementById('gN-kick').textContent !== '' && document.getElementById('busy').hidden, null, { timeout: 30000 });
    assert.equal(await text('gN-kick'), '32');
    assert.equal(await text('gN-snare'), '32');
    assert.match(await text('gSum'), /^16 bars · 9\d\.\d BPM · Against the hats/);
    const [d] = await Promise.all([page.waitForEvent('download'), page.click('#gMidi')]);
    assert.equal(d.suggestedFilename(), 'drifting-drum-loop-drums.mid');
  });
  assert.deepEqual(errors, []);
  console.log('e2e smoke passed');
} finally {
  await browser.close();
  await new Promise((r) => server.httpServer.close(r));
}
