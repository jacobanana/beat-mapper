// The top bar, grouped the way DAWs and editors group it: file and edit on the left, then the steps,
// the transport with its readout, the view, and help at the far right. The
// mixer and the Export window that open from it are in mixer-panel.ts and export-dialog.ts.
import type { App } from '../../app/app';
import type { Features } from '../../app/features';
import { stepRules } from '../../app/steps';
import { fmtTime } from '../../core/format';
import { STEP, STEPS, type Step } from '../../state/steps';
import { $, $btn, icon, setPressed } from '../dom';
import { confirmAction } from './confirm';
import { STEP_FORMATS } from './export-dialog';

const WARP_TITLE = 'Warped: Warp, Slice, Groove and Notes hear, cut, measure and export the audio moved onto the grid; off, the original (W)';

/** What each step's Reset asks: what goes, and whether undo brings it back. */
const RESET_ASK: Record<Step, [string, string]> = {
  [STEP.transients]: ['Reset Transients?', 'Detection goes back to how it starts, and the markers to how they were found. Undo brings back your marker edits.'],
  [STEP.beats]: ['Reset Beats?', 'Only bar 1 stays, on the first transient, in 4/4 at the starting tempo. Undo brings back your map.'],
  [STEP.warp]: ['Reset Warp?', 'The whole file is warped at the tempo it averages, as a full mix, and the warp markers come off. Your grid tempo and material are cleared, the shuffle goes back to 0%, the quantize strength to 100% and gaps are left unfilled; undo brings back the warp markers.'],
  [STEP.slice]: ['Reset Slice?', 'Every transient starts a slice again, and every slice is kept. Dropped slices can\'t be brought back with undo.'],
  [STEP.groove]: ['Reset Groove?', 'The hits go back to how they were found, at the starting sensitivities. Undo brings back your hit edits.'],
  [STEP.notes]: ['Reset Notes?', 'Every note comes back as found, at the starting sensitivity, as long as it is heard. Undo brings back your deletions.'],
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
  const RESETS = ['resetM', 'resetB', 'resetW', 'resetS', 'gReset', 'nReset'];
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
    $('warpBtn').hidden = !stepRules(app.step).hearsWarp;
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

  // The switch shows how it is set, and dims when it is on but the original is what plays: no warp to
  // make (a loop warped alone with the loop off), or one that couldn't be rendered.
  const syncWarp = () => {
    const b = $('warpBtn'), off = app.warp.listen && (!app.hearingWarp || f.warpRender.unavailable);
    setPressed(b, app.warp.listen);
    b.classList.toggle('idle', off);
    b.title = off ? 'Warped is on, but the original plays: ' + (app.hearingWarp ? "the warp couldn't be rendered" : 'there is nothing to warp') + ' (W)' : WARP_TITLE;
  };

  app.bus.on('step', syncSteps);
  app.bus.on(['warp', 'heard', 'step'], syncWarp);
  app.bus.on(['step', 'doc', 'detection', 'candidates', 'beats', 'warp', 'slicer', 'slices', 'groove', 'drums', 'notes', 'transcript', 'audio'], syncReset);
  app.bus.on(['doc', 'audio'], syncHistory);
  app.bus.on(['transport', 'playhead'], syncTransport);
  app.bus.on(['playhead', 'heard', 'doc', 'audio'], syncReadout);
  app.bus.on('audio', syncFile);
  syncSteps();
  syncWarp();
  syncTransport();
  syncReset();
}
