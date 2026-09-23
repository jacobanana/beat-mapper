// Step 5 – Groove: the drum voices, what the pocket is measured against, and the chart. Its files are
// saved from the Export window, and what play sounds like here (audio, synth kit, both) is in the mixer.
import type { App } from '../../app/app';
import type { Features } from '../../app/features';
import type { DrumSource } from '../../core/drums/detect';
import { VOICES } from '../../core/drums/voices';
import type { GrooveGrid, Reference } from '../../core/groove/pocket';
import { GrooveChart } from '../canvas/groove-chart';
import { $, $btn, $in, $sel, setPressed, setText, setValue } from '../dom';

export function bindGroovePanel(app: App, f: Features): GrooveChart {
  const gr = f.groove;
  $sel('gSource').onchange = (e) => void gr.setSource((e.target as HTMLSelectElement).value as DrumSource);
  for (const v of VOICES) $in('gSens-' + v).oninput = (e) => gr.setSensitivity(v, +(e.target as HTMLInputElement).value);
  $sel('gGrid').onchange = (e) => gr.setGrid((e.target as HTMLSelectElement).value as GrooveGrid);
  $sel('gRef').onchange = (e) => gr.setReference((e.target as HTMLSelectElement).value as Reference | 'auto');
  $('gExag').onclick = () => gr.toggleExaggerate();
  $('gChartPocket').onclick = () => gr.setChart('pocket');
  $('gChartMidi').onclick = () => gr.setChart('midi');
  $('gDel').onclick = () => gr.removeSelected();

  const chart = new GrooveChart($('grooveCv') as HTMLCanvasElement, app);
  const sync = () => {
    const s = app.groove;
    setValue($sel('gSource'), s.source);
    for (const v of VOICES) setValue($in('gSens-' + v), s.sens[v]);
    setValue($sel('gGrid'), s.grid);
    setValue($sel('gRef'), s.ref);
    setPressed($('gExag'), s.exaggerate);
    $btn('gExag').disabled = s.chart !== 'pocket';
    setPressed($('gChartPocket'), s.chart === 'pocket');
    setPressed($('gChartMidi'), s.chart === 'midi');
  };
  const edits = () => {
    $btn('gDel').disabled = !app.selectedHit();
  };
  const counts = () => {
    const h = app.drumHits;
    for (const v of VOICES) setText($('gN-' + v), h ? String(h[v].length) : '');
    setText($('gSum'), gr.summary());
  };
  app.bus.on('groove', sync);
  app.bus.on(['doc', 'selection', 'drums', 'groove'], edits);
  app.bus.on(['groove', 'drums', 'doc', 'transport', 'audio'], counts);
  sync();
  edits();
  return chart;
}
