// Step 1 – Transients.
import type { App } from '../../app/app';
import type { Features } from '../../app/features';
import type { Algo, Band } from '../../core/dsp/onset';
import { plural } from '../../core/format';
import { $, $in, $sel, setPressed, setValue } from '../dom';

export function bindDetectPanel(app: App, f: Features): void {
  $in('sens').oninput = (e) => f.markers.setSensitivity(+(e.target as HTMLInputElement).value);
  $in('gap').oninput = (e) => f.markers.setGap(+(e.target as HTMLInputElement).value);
  $sel('band').onchange = (e) => void f.markers.setBand((e.target as HTMLSelectElement).value as Band);
  $sel('algo').onchange = (e) => void f.markers.setAlgo((e.target as HTMLSelectElement).value as Algo);
  $('odfBtn').onclick = () => f.markers.toggleOdf();
  $('prevM').onclick = () => f.markers.tab(-1);
  $('nextM').onclick = () => f.markers.tab(1);
  $('addM').onclick = () => f.markers.add(app.transport.playhead);
  $('delM').onclick = () => f.markers.removeSelected();

  const sync = () => {
    const d = app.detection;
    setValue($in('sens'), d.sens);
    $('sensO').textContent = d.sens + '%';
    setValue($in('gap'), d.gap);
    $('gapO').textContent = d.gap + ' ms';
    setValue($sel('band'), d.band);
    setValue($sel('algo'), d.algo);
    setPressed($('odfBtn'), d.showOdf);
  };
  // Counts say what they count, so a bare number never has to be guessed at.
  const count = () => { $('mCount').textContent = app.audio ? plural(app.markers.length, 'marker') : ''; };
  app.bus.on('detection', sync);
  app.bus.on(['detection', 'doc', 'candidates', 'audio'], count);
  sync();
}
