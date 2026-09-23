// Step 3 – Export: MIDI, REAPER, and the session file.
import type { App } from '../../app/app';
import type { Features } from '../../app/features';
import { fmtTime } from '../../core/format';
import { buildMidi } from '../../io/formats/midi';
import { $, $in, $sel, setValue } from '../dom';

export function bindExportPanel(app: App, f: Features, onPick: (e: Event) => void): void {
  $sel('lead').onchange = (e) => app.set('export', { lead: (e.target as HTMLSelectElement).value === 'trim' ? 'trim' : 'full' });
  $sel('res').onchange = (e) => app.set('export', { res: (e.target as HTMLSelectElement).value as 'pins' | 'bar' | 'beat' });
  $in('clicks').onchange = (e) => app.set('export', { clicks: (e.target as HTMLInputElement).checked });
  $in('rppAudio').onchange = (e) => app.set('export', { rppAudio: (e.target as HTMLInputElement).checked });
  $('saveBtn').onclick = () => void f.exports.saveMidi();
  $('saveRpp').onclick = () => void f.exports.saveRpp();
  $('sessSave').onclick = () => void f.sessions.export();
  $in('sessIn').addEventListener('change', onPick);
  if (matchMedia('(pointer:fine)').matches) $in('sessIn').accept = '.json,application/json';
  $('sessOpen').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); $in('sessIn').click(); }
  });

  const sync = () => {
    const s = app.exportSettings;
    setValue($sel('lead'), s.lead);
    setValue($sel('res'), s.res);
    $in('clicks').checked = s.clicks;
    $in('rppAudio').checked = s.rppAudio;
  };

  // What the export will hold, and where to put the audio in the DAW.
  const info = () => {
    if ($('p3').hidden || !app.hasMap) return;
    try {
      const o = f.exports.options(), { info, bytes } = buildMidi(o), { num, den } = app.doc.meter;
      let s = `${info.count} tempo change${info.count === 1 ? '' : 's'}, ${info.minB.toFixed(1)}–${info.maxB.toFixed(1)} BPM, ${num}/${den}, ${(bytes.length / 1024).toFixed(1)} KB. `;
      if (o.trimmed) s += `Trim the audio so it starts at ${fmtTime(info.t0)} and put it on bar 1.`;
      else if (info.leadBpm) {
        s += `Put the audio at the very start of the project; the first downbeat lands on bar ${info.leadBars + 1}.`;
        if (info.leadBpm > info.songBpm * 2.4) s += ` The lead-in is only ${(info.t0 * 1000).toFixed(0)} ms, so its tempo is ${info.leadBpm.toFixed(0)} BPM – trimming may be cleaner.`;
      } else s += 'Put the audio at bar 1.';
      $('expInfo').textContent = s;
    } catch {
      $('expInfo').textContent = 'Set bar 1 and at least a tempo in step 2 first.';
    }
  };

  app.bus.on('export', sync);
  app.bus.on(['export', 'doc', 'step', 'audio'], info);
  sync();
}
