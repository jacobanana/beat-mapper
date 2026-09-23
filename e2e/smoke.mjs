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
    assert.equal(await text('mCount'), '128 markers');
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
    assert.equal(await text('mCount'), '129 markers');
    await page.keyboard.press('Control+z');
    assert.equal(await text('mCount'), '128 markers');
  });
  await step('Transients makes nothing to export; the session is by Open', async () => {
    assert.equal(await page.isDisabled('#exportBtn'), true);
    await page.click('#sessBtn');
    assert.equal(await page.isVisible('#sessPop'), true);
    const [d] = await Promise.all([page.waitForEvent('download'), page.click('#sessSave')]);
    assert.equal(d.suggestedFilename(), 'drifting-drum-loop-session.json');
    assert.equal(await page.isVisible('#sessPop'), false);
  });
  await step('Beats: bar 1, then auto-map', async () => {
    await page.keyboard.press('2');
    assert.equal(await text('aCount'), '1 pin');
    await page.keyboard.press('m');
    assert.equal(await text('aCount'), '64 pins');
    assert.match(await text('sum'), /^17 bars · avg 98\.16/);
  });
  await step('Export: MIDI file downloads', async () => {
    await page.keyboard.press('Control+e');
    assert.equal(await page.isVisible('#exportDlg'), true);
    assert.equal(await page.getAttribute('[data-fmt=midi]', 'aria-pressed'), 'true');
    // Only what Beats makes is listed: the warped audio is the Warp step's.
    assert.equal(await page.isVisible('[data-fmt=warpWav]'), false);
    assert.equal(await page.isVisible('[data-fmt=slices]'), false);
    assert.equal(await page.isVisible('[data-fmt=drumsMidi]'), false);
    assert.match(await text('expInfo'), /tempo changes/);
    assert.equal(await page.isVisible('#lead'), true);
    assert.equal(await page.isVisible('#slBits'), false);
    const [d] = await Promise.all([page.waitForEvent('download'), page.click('#expSave')]);
    assert.equal(await page.isVisible('#exportDlg'), false);
    assert.equal(d.suggestedFilename(), 'drifting-drum-loop-tempo-map.mid');
  });
  await step('Warp: the grid tempo from a looped section', async () => {
    await page.keyboard.press('3');
    assert.equal(await page.isVisible('#p3'), true);
    assert.equal(await page.isVisible('#warpListen'), false);
    assert.equal(await page.getAttribute('#wWarped', 'aria-pressed'), 'true');
    assert.match(await text('wSum'), /^The file averages 97\.87 BPM · warped to 98 BPM, stretched \d+ %–\d+ %/);
    assert.equal(await page.getAttribute('#warpBpmB', 'placeholder'), '98');
    assert.equal(await page.isDisabled('#wFromLoop'), true);
    // Loop the last third, where the demo is fastest, and take its tempo.
    await page.keyboard.press('z');
    const b = await (await page.$('#cv')).boundingBox();
    await page.mouse.move(b.x + b.width * 0.66, b.y + 10);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width * 0.8, b.y + 10, { steps: 5 });
    await page.mouse.move(b.x + b.width - 4, b.y + 10, { steps: 5 });
    await page.mouse.up();
    assert.equal(await page.isDisabled('#wFromLoop'), false);
    await page.click('#wFromLoop');
    const bpm = await page.inputValue('#warpBpmB');
    assert.ok(+bpm >= 100, 'the end of the demo is faster: ' + bpm);
    // Taking the loop's tempo still warps the whole file.
    assert.match(await text('wSum'), new RegExp(`^The file averages .* warped to ${bpm} BPM`));
    await page.keyboard.press('l');
  });
  await step('Warp: hear it, with the playhead on the original, and A/B', async () => {
    await page.selectOption('#warpModeB', 'beats');
    await page.keyboard.press('Home');
    await page.keyboard.press(' ');
    await page.waitForFunction(() => document.getElementById('playBtn').dataset.state === 'true' && document.getElementById('busy').hidden, null, { timeout: 30000 });
    await page.waitForTimeout(700);
    assert.notEqual(await text('rTime'), '0:00.000');
    await page.keyboard.press('w');
    assert.equal(await page.getAttribute('#wOrig', 'aria-pressed'), 'true');
    await page.waitForTimeout(300);
    assert.equal(await page.$eval('#playBtn', (b) => b.dataset.state), 'true');
    await page.keyboard.press(' ');
    await page.keyboard.press('w');
  });
  await step('Export: the audio warped onto a straight grid downloads as a .wav', async () => {
    await page.keyboard.press('Control+e');
    assert.equal(await page.getAttribute('[data-fmt=warpWav]', 'aria-pressed'), 'true');
    assert.equal(await page.isVisible('[data-fmt=midi]'), false);
    assert.equal(await page.inputValue('#warpMode'), 'beats');
    assert.equal(await page.isVisible('#clicks'), false);
    assert.match(await text('expInfo'), /^Cut at the transients.* at \d+ BPM, stretched \d+ %–\d+ %\./);
    await page.fill('#warpBpm', '100');
    await page.dispatchEvent('#warpBpm', 'change');
    assert.match(await text('expInfo'), / at 100 BPM/);
    const [d] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('#expSave')]);
    assert.equal(d.suggestedFilename(), 'drifting-drum-loop_warped_100bpm.wav');
    assert.equal(await page.inputValue('#warpBpmB'), '100');
  });
  await step('Warp: Reset goes back to the average', async () => {
    await page.click('#resetW');
    assert.equal(await page.inputValue('#warpBpmB'), '');
    assert.equal(await page.inputValue('#warpModeB'), 'music');
    assert.equal(await page.isDisabled('#resetW'), true);
  });
  await step('Beats: Reset starts the map again, undo brings it back', async () => {
    await page.keyboard.press('2');
    assert.equal(await page.isDisabled('#resetB'), false);
    await page.click('#resetB');
    assert.equal(await text('aCount'), '1 pin');
    assert.equal(await page.isDisabled('#resetB'), true);
    await page.keyboard.press('Control+z');
    assert.equal(await text('aCount'), '64 pins');
  });
  await step('Export on a phone: the formats are a dropdown', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.keyboard.press('Control+e');
    assert.equal(await page.isVisible('#fmtList'), false);
    // It opens on the format last chosen in this step.
    assert.equal(await text('fmtPickNm'), 'MIDI');
    // With the options below, the button keeps its height: nothing of its subtitle is cut.
    assert.equal(await page.$eval('#fmtPick', (b) => b.scrollHeight - b.clientHeight), 0);
    await page.click('#fmtPick');
    assert.equal(await page.getAttribute('#fmtPick', 'aria-expanded'), 'true');
    await page.click('#fmtList [data-fmt=rpp]');
    assert.equal(await page.isVisible('#fmtList'), false);
    assert.equal(await text('fmtPickNm'), 'REAPER');
    assert.equal(await page.isVisible('#rppAudio'), true);
    // Escape closes the list first, then the window.
    await page.click('#fmtPick');
    await page.keyboard.press('Escape');
    assert.equal(await page.isVisible('#fmtList'), false);
    assert.equal(await page.isVisible('#exportDlg'), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.isVisible('#exportDlg'), false);
    await page.setViewportSize({ width: 1280, height: 800 });
  });
  await step('Slice: one slice per transient', async () => {
    await page.keyboard.press('4');
    assert.equal(await text('slCount'), '128/128 kept');
    await page.click('#exportBtn');
    assert.equal(await page.getAttribute('[data-fmt=slices]', 'aria-pressed'), 'true');
    assert.equal(await page.isVisible('[data-fmt=midi]'), false);
    assert.equal(await page.isVisible('#slBits'), true);
    assert.equal(await page.isVisible('#lead'), false);
    assert.equal(await page.isVisible('#clicks'), false);
    await page.click('[data-fmt=loopWav]');
    assert.equal(await page.isDisabled('#expSave'), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.isVisible('#exportDlg'), false);
  });
  await step('Groove: kick, snare and hats found and measured', async () => {
    await page.keyboard.press('5');
    await page.waitForFunction(() => document.getElementById('gN-kick').textContent !== '' && document.getElementById('busy').hidden, null, { timeout: 30000 });
    assert.equal(await text('gN-kick'), '32');
    assert.equal(await text('gN-snare'), '32');
    assert.match(await text('gSum'), /^16 bars · 9\d\.\d BPM · Against the hats/);
    await page.keyboard.press('Control+e');
    assert.equal(await page.getAttribute('[data-fmt=drumsMidi]', 'aria-pressed'), 'true');
    const [d] = await Promise.all([page.waitForEvent('download'), page.click('#expSave')]);
    assert.equal(d.suggestedFilename(), 'drifting-drum-loop-drums.mid');
  });
  await step('Groove: a double-click in a lane adds a hit, Delete takes it away', async () => {
    const b = await (await page.$('#cv')).boundingBox();
    // The kick lane is the bottom third of the waveform (loop strip and bar ruler above, tempo lane and time ruler below).
    const wy = 42, wh = b.height - wy - 50 - 22, y = wy + wh * (5 / 6);
    let x = 300;
    for (; x < 1200; x += 3) {
      await page.mouse.move(b.x + x, b.y + y);
      if ((await page.$eval('#cv', (e) => e.style.cursor)) === 'default') break;
    }
    await page.mouse.dblclick(b.x + x, b.y + y);
    assert.equal(await text('gN-kick'), '33');
    assert.equal(await page.isDisabled('#gReset'), false);
    await page.keyboard.press('Delete');
    assert.equal(await text('gN-kick'), '32');
    await page.keyboard.press('Control+z');
    assert.equal(await text('gN-kick'), '33');
    await page.click('#gReset');
    assert.equal(await text('gN-kick'), '32');
  });
  await step('Groove: hear the drums as MIDI, and chart them as a transcript', async () => {
    await page.click('#mixBtn');
    assert.equal(await page.isVisible('#mixer'), true);
    assert.equal(await page.getAttribute('#mute-drums', 'aria-pressed'), 'false');
    await page.click('#mute-drums');
    assert.equal(await page.getAttribute('#mute-drums', 'aria-pressed'), 'true');
    await page.click('#mute-audio');
    assert.equal(await page.getAttribute('#mute-audio', 'aria-pressed'), 'false');
    await page.click('#mute-audio');
    await page.fill('#mix-drums', '120');
    assert.equal(await text('mixO-drums'), '120%');
    await page.click('#gChartPocket');
    assert.equal(await page.isVisible('#mixer'), false);
    await page.click('#clickBtn');
    assert.equal(await page.getAttribute('#clickBtn', 'aria-pressed'), 'true');
    await page.click('#mixBtn');
    assert.equal(await page.getAttribute('#mute-click', 'aria-pressed'), 'true');
    await page.click('#mute-click');
    assert.equal(await page.getAttribute('#clickBtn', 'aria-pressed'), 'false');
    await page.keyboard.press('Escape');
    await page.click('#gChartMidi');
    assert.equal(await page.getAttribute('#gChartMidi', 'aria-pressed'), 'true');
    assert.equal(await page.isDisabled('#gExag'), true);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(600);
    await page.keyboard.press(' ');
    await page.keyboard.press('c');
    assert.equal(await page.getAttribute('#gChartPocket', 'aria-pressed'), 'true');
  });
  assert.deepEqual(errors, []);
  console.log('e2e smoke passed');
} finally {
  await browser.close();
  await new Promise((r) => server.httpServer.close(r));
}
