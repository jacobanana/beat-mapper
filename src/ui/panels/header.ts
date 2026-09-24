// The top bar, grouped the way DAWs and editors group it: file and edit on the left, then the steps,
// the transport with its readout, the view, and help at the far right. The
// mixer and the Export window that open from it are in mixer-panel.ts and export-dialog.ts.
import type { App } from '../../app/app';
import type { Features } from '../../app/features';
import { fmtTime } from '../../core/format';
import { $, $btn, icon, setPressed } from '../dom';
import { confirmAction } from './confirm';
import { STEP_FORMATS } from './export-dialog';

const STEPS = [1, 2, 3, 4, 5] as const;

/** What each step's Reset asks: what goes, and whether undo brings it back. */
const RESET_ASK: Record<(typeof STEPS)[number], [string, string]> = {
  1: ['Reset Transients?', 'Detection goes back to how it starts, and the markers to how they were found. Undo brings back your marker edits.'],
  2: ['Reset Beats?', 'Only bar 1 stays, on the first transient, in 4/4 at the starting tempo. Undo brings back your map.'],
  3: ['Reset Warp?', 'The whole file is warped at the tempo it averages, as a full mix, and the warp markers come off. Your grid tempo and material are cleared, the shuffle goes back to 0% and the quantize strength to 100%; undo brings back the warp markers.'],
  4: ['Reset Slice?', 'Every transient starts a slice again, and every slice is kept. Dropped slices can\'t be brought back with undo.'],
  5: ['Reset Groove?', 'The hits go back to how they were found, at the starting sensitivities. Undo brings back your hit edits.'],
};

export function bindHeader(app: App, f: Features, openHelp: () => void, openExport: () => void): void {
  for (const n of STEPS) $('t' + n).onclick = () => f.workflow.goTo(n);
  $('exportBtn').onclick = openExport;

  const zoomKey = (k: number) => {
    const v = app.view, tc = v.contains(app.transport.playhead) ? app.transport.playhead : (v.t0 + v.t1) / 2;
    v.zoomAt(k, tc);
    app.bus.emit('view');
  };
  $('zIn').onclick = () => zoomKey(0.5);
  $('zOut').onclick = () => zoomKey(2);
  $('zFit').onclick = () => { if (app.audio) app.setView(0, app.dur); };
  $('undoBtn').onclick = () => { if (!app.undo()) app.notify.toast('Nothing to undo'); };
  $('redoBtn').onclick = () => { if (!app.redo()) app.notify.toast('Nothing to redo'); };
  $('helpBtn').onclick = openHelp;

  $('playBtn').onclick = () => f.playback.togglePlay(false);
  $('fromStart').onclick = () => f.playback.playFromStart(false);
  $('stayBtn').onclick = () => f.playback.toggleStay();
  $('loopBtn').onclick = () => f.playback.toggleLoop();
  $('scrubBtn').onclick = () => f.playback.toggleScrub();
  $('clickBtn').onclick = () => f.playback.toggleClick();
  $('warpBtn').onclick = () => f.warp.toggleListen();
  // Each step's Reset, last in its panel: it starts that step again, once confirmed.
  const RESETS = ['resetM', 'resetB', 'resetW', 'resetS', 'gReset'];
  for (const id of RESETS) {
    $(id).onclick = async () => {
      const [title, text] = RESET_ASK[app.step];
      if (await confirmAction(title, text)) f.workflow.resetStep();
    };
  }

  const syncSteps = () => {
    for (const i of STEPS) {
      $('t' + i).setAttribute('aria-selected', String(i === app.step));
      $('p' + i).hidden = i !== app.step;
    }
    // Warped or not is for the steps after the warp is made; Transients and Beats hear the original.
    $('warpBtn').hidden = app.step < 3;
    // Export follows the step: off where the step makes nothing to export.
    const none = !STEP_FORMATS[app.step].length, ex = $btn('exportBtn');
    ex.disabled = none;
    ex.title = none ? 'Nothing to export from this step' : 'Export what this step makes (Ctrl/Cmd+E)';
  };
  const syncTransport = () => {
    const t = app.transport;
    setPressed($('stayBtn'), t.stay);
    setPressed($('loopBtn'), t.loopOn);
    setPressed($('scrubBtn'), t.scrubMode);
    setPressed($('clickBtn'), t.click);
    const playing = f.playback.playing, btn = $('playBtn');
    if (btn.dataset.state !== String(playing)) { btn.dataset.state = String(playing); btn.innerHTML = icon(playing ? 'stop' : 'play'); }
  };
  const syncReadout = () => {
    const t = app.transport.playhead;
    $('rTime').textContent = fmtTime(t);
    if (app.hasMap) {
      // What is heard at the playhead, on the grid drawn under it.
      const tl = app.timeline, bb = tl.barBeatAt(t, app.doc.meter);
      $('rPos').textContent = bb ? bb.bar + 1 + '.' + (bb.beat + 1) : 'lead-in';
      $('rBpm').textContent = tl.bpmAt(t).toFixed(2);
    } else {
      $('rPos').textContent = '–';
      $('rBpm').textContent = '–';
    }
  };
  const syncFile = () => {
    const a = app.audio;
    $('empty').hidden = !!a;
    if (!a) return;
    $('fileInfo').textContent = a.name;
    $('fileInfo').title = `${a.name} · ${fmtTime(a.dur)} · ${(a.sr / 1000).toFixed(1)} kHz`;
  };

  // Undo and redo grey out when there is nothing to take back or bring back, as in any editor.
  const syncHistory = () => {
    $btn('undoBtn').disabled = !app.history.canUndo;
    $btn('redoBtn').disabled = !app.history.canRedo;
  };

  const syncReset = () => { for (const id of RESETS) $btn(id).disabled = !f.workflow.canReset; };

  const syncWarp = () => setPressed($('warpBtn'), app.warp.listen);

  app.bus.on('step', syncSteps);
  app.bus.on('warp', syncWarp);
  app.bus.on(['step', 'doc', 'detection', 'candidates', 'beats', 'warp', 'slicer', 'slices', 'groove', 'drums', 'audio'], syncReset);
  app.bus.on(['doc', 'audio'], syncHistory);
  app.bus.on(['transport', 'playhead'], syncTransport);
  app.bus.on(['playhead', 'doc', 'audio', 'step', 'warp', 'transport'], syncReadout);
  app.bus.on('audio', syncFile);
  syncSteps();
  syncWarp();
  syncTransport();
  syncReset();
}
