// The top bar: open, the steps, export, zoom, undo, help, transport buttons and the time readout. The
// mixer and the Export window that open from it are in mixer-panel.ts and export-dialog.ts.
import type { App } from '../../app/app';
import type { Features } from '../../app/features';
import { fmtTime } from '../../core/format';
import { $, icon, setPressed } from '../dom';

// Step 3 was Export; it is the Export window now, so the tabs skip it.
const STEPS = [1, 2, 4, 5] as const;

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
  $('helpBtn').onclick = openHelp;

  $('playBtn').onclick = () => f.playback.togglePlay(false);
  $('fromStart').onclick = () => f.playback.playFromStart(false);
  $('stayBtn').onclick = () => f.playback.toggleStay();
  $('loopBtn').onclick = () => f.playback.toggleLoop();
  $('scrubBtn').onclick = () => f.playback.toggleScrub();
  $('clickBtn').onclick = () => f.playback.toggleClick();

  const syncSteps = () => {
    for (const i of STEPS) {
      $('t' + i).setAttribute('aria-selected', String(i === app.step));
      $('p' + i).hidden = i !== app.step;
    }
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
      const bb = app.tempoMap.barBeatAt(t, app.doc.meter);
      $('rPos').textContent = bb ? bb.bar + 1 + '.' + (bb.beat + 1) : 'lead-in';
      $('rBpm').textContent = app.tempoMap.bpmAt(t).toFixed(2);
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

  app.bus.on('step', syncSteps);
  app.bus.on(['transport', 'playhead'], syncTransport);
  app.bus.on(['playhead', 'doc', 'audio'], syncReadout);
  app.bus.on('audio', syncFile);
  syncSteps();
  syncTransport();
}
