// Step 4 – Slice samples: the slicing settings, the list of slices, and saving them.
import type { App } from '../../app/app';
import type { Features } from '../../app/features';
import { fmtBpm, fmtTime } from '../../core/format';
import type { SlicerSettings } from '../../state/settings';
import { $, $in, $sel, clampNum, icon, setText, setValue } from '../dom';

/** Rows beyond this are summarised, not listed. */
const SL_ROWS = 1500;

export function bindSlicePanel(app: App, f: Features): void {
  const s = f.slicer;

  // Every control writes the whole settings group back, clamped, like the original form did.
  const read = () => {
    const patch: Partial<SlicerSettings> = {
      mode: $sel('slMode').value === 'fixed' ? 'fixed' : 'gap',
      len: clampNum($in('slLen').value, 500, 5, 60000),
      tail: clampNum($in('slTail').value, 0, 0, 5000),
      fadeIn: clampNum($in('slFadeIn').value, 0, 0, 500),
      fadeOut: clampNum($in('slFadeOut').value, 0, 0, 2000),
      min: clampNum($in('slMin').value, 0, 0, 5000),
      mono: $sel('slMono').value === 'mono',
      bits: +$sel('slBits').value === 24 ? 24 : 16,
      norm: $in('slNorm').checked,
      target: clampNum($in('slTarget').value, -1, -24, 0),
      naming: $sel('slName').value === 'time' ? 'time' : 'num',
    };
    s.update(patch);
    sync();
  };
  document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('#p4 input, #p4 select').forEach((el) => {
    if (el.id === 'slCsv') el.addEventListener('change', () => s.update({ csv: $in('slCsv').checked }));
    else el.addEventListener('change', read);
  });
  $('slPrev').onclick = () => s.tab(-1);
  $('slNext').onclick = () => s.tab(1);
  $('slPlay').onclick = () => s.previewSelected();
  $('slOff').onclick = () => s.toggleSelected();
  $('slAll').onclick = () => s.keepAll();
  $('slWav').onclick = () => void s.saveSelectedWav();
  $('slLoop').onclick = () => void s.saveLoopWav();
  $('slZip').onclick = () => void s.exportZip(false);
  $('slRpp').onclick = () => void s.exportZip(true);

  const rows = $('sliceRows') as HTMLTableSectionElement;
  rows.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const box = t.closest<HTMLInputElement>('input[type=checkbox]');
    if (box) return s.toggle(+box.dataset.i!);
    const btn = t.closest<HTMLElement>('button[data-p]');
    if (btn) return s.preview(+btn.dataset.p!);
    const tr = t.closest<HTMLElement>('tr[data-i]'), sl = tr && app.slices[+tr.dataset.i!];
    if (!sl) return;
    const len = sl.t1 - sl.t0;
    app.setView(sl.t0 - len * 0.5, sl.t1 + len * 0.5);
    f.playback.seek(sl.t0, true);
    s.preview(sl.i);
  });

  const sync = () => {
    const o = app.slicer;
    setValue($sel('slMode'), o.mode); setValue($in('slLen'), o.len); setValue($in('slTail'), o.tail);
    setValue($in('slFadeIn'), o.fadeIn); setValue($in('slFadeOut'), o.fadeOut); setValue($in('slMin'), o.min);
    setValue($sel('slMono'), o.mono ? 'mono' : 'src'); setValue($sel('slBits'), o.bits); $in('slNorm').checked = o.norm;
    setValue($in('slTarget'), o.target); setValue($sel('slName'), o.naming); $in('slCsv').checked = o.csv;
    $in('slLen').disabled = o.mode !== 'fixed';
    $in('slTail').disabled = o.mode === 'fixed';
    $in('slTarget').disabled = !o.norm;
  };

  const peakDb = (t0: number, t1: number) => {
    const a = app.audio!, m = a.peaks.minmax(Math.floor(t0 * a.sr), Math.ceil(t1 * a.sr)), pk = m ? Math.max(Math.abs(m[0]), Math.abs(m[1])) : 0;
    return pk > 1e-6 ? (20 * Math.log10(pk)).toFixed(1) : '–∞';
  };

  // Rows are patched in place, never rebuilt: a row the pointer is on has to survive the re-render that
  // a number field's change event fires as it loses focus, or that first click would be swallowed.
  let lastSel: number | null = null;
  const render = () => {
    const S = app.slices, sel = app.sliceIndex;
    $('slCount').textContent = S.length ? S.filter((x) => !x.off).length + '/' + S.length : '';
    if ($('p4').hidden) return;
    const n = Math.min(S.length, SL_ROWS);
    while (rows.rows.length > n) rows.deleteRow(rows.rows.length - 1);
    while (rows.rows.length < n) {
      const tr = rows.insertRow();
      tr.innerHTML = '<td><input type="checkbox"></td><td></td><td></td><td></td><td></td><td><button class="mini"></button></td>';
      (tr.cells[5].firstChild as HTMLElement).innerHTML = icon('play');
    }
    for (let i = 0; i < n; i++) {
      const sl = S[i], tr = rows.rows[i], box = tr.cells[0].firstChild as HTMLInputElement, btn = tr.cells[5].firstChild as HTMLButtonElement;
      tr.dataset.i = String(sl.i);
      tr.className = [sl.i === sel ? 'cur' : '', sl.off ? 'off' : ''].filter(Boolean).join(' ');
      box.dataset.i = String(sl.i);
      if (box.checked === sl.off) box.checked = !sl.off;
      box.setAttribute('aria-label', 'Keep slice ' + (sl.i + 1));
      setText(tr.cells[1], String(sl.i + 1));
      setText(tr.cells[2], fmtTime(sl.t0));
      setText(tr.cells[3], String(Math.round((sl.t1 - sl.t0) * 1000)));
      setText(tr.cells[4], peakDb(sl.t0, sl.t1));
      btn.dataset.p = String(sl.i);
      btn.title = 'Preview slice ' + (sl.i + 1);
      btn.setAttribute('aria-label', btn.title);
    }
    let tot = 0, on = 0;
    for (const sl of S) if (!sl.off) { tot += sl.t1 - sl.t0; on++; }
    if (!S.length) $('slSum').textContent = app.audio ? 'No slices – add transients in step 1, or lower the minimum length.' : '';
    else {
      const b = s.zipEstimate(), L = app.loopInfo;
      $('slSum').textContent = `${on} of ${S.length} slices · ${fmtTime(tot)} of audio · zip about ${b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.round(b / 1024) + ' KB'}`
        + (L ? ` · loop only: ${L.bars} bar${L.bars === 1 ? '' : 's'} at ${fmtBpm(L.bpm)} BPM (${fmtTime(L.a)}–${fmtTime(L.b)})` : '')
        + (n < S.length ? ` · first ${n} listed` : '');
    }
    if (sel != null && sel !== lastSel) rows.querySelector(`tr[data-i="${sel}"]`)?.scrollIntoView?.({ block: 'nearest' });
    lastSel = sel;
  };

  app.bus.on('slicer', sync);
  app.bus.on(['slices', 'slicer', 'doc', 'candidates', 'detection', 'transport', 'step', 'audio'], render);
  sync();
}
