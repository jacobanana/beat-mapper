// Step 2 – Beats: the tempo to start from, mapping the beats, fixing single beats, and the table of
// bars. What changes mapping and snapping is folded away under Options.
import type { App } from '../../app/app';
import type { Features } from '../../app/features';
import { fmtTime, plural } from '../../core/format';
import { type GridDivision, swings } from '../../core/tempo/meter';
import type { SnapMode } from '../../state/settings';
import { $, $in, $sel, clampNum, setText, setValue } from '../dom';

export function bindBeatsPanel(app: App, f: Features, refocus: () => void): void {
  const b = f.beats;
  $in('num').onchange = (e) => { b.setMeter({ num: Math.max(1, Math.min(32, Math.round(+(e.target as HTMLInputElement).value) || 4)) }); refocus(); };
  $sel('den').onchange = (e) => b.setMeter({ den: +(e.target as HTMLSelectElement).value });
  $sel('grid').onchange = (e) => b.setGrid((e.target as HTMLSelectElement).value as GridDivision);
  $in('bpm').onchange = (e) => { b.setBaseBpm(clampNum((e.target as HTMLInputElement).value, 120, 20, 400)); refocus(); };
  $('tap').onclick = () => b.tap();
  $('setDown').onclick = () => b.setDownbeat(app.transport.playhead);
  $('pinHere').onclick = () => b.pinAt(app.transport.playhead);
  $('unpin').onclick = () => b.unpinSelected();
  $sel('snapTo').onchange = (e) => b.setSnap((e.target as HTMLSelectElement).value as SnapMode, true);
  $('derive').onclick = () => b.deriveFromLoop();
  $in('loopBars').onchange = (e) => { const n = Math.round(+(e.target as HTMLInputElement).value); app.set('beats', { loopBars: n >= 1 ? n : null }); };
  $('autoMap').onclick = () => b.autoMap();
  $sel('mapEvery').onchange = (e) => app.set('beats', { mapEvery: (e.target as HTMLSelectElement).value === 'bar' ? 'bar' : 'beat' });
  $in('shuffle').oninput = (e) => b.setShuffle(+(e.target as HTMLInputElement).value);
  $in('tol').oninput = (e) => app.set('beats', { tol: +(e.target as HTMLInputElement).value });

  const rows = $('barRows');
  rows.addEventListener('click', (e) => {
    const tr = (e.target as HTMLElement).closest<HTMLElement>('tr[data-b]');
    const bar = tr && app.bars[+tr.dataset.b!];
    if (!bar) return;
    const len = bar.te - bar.ts;
    app.setView(bar.ts - len * 0.5, bar.te + len * 1.5);
    f.playback.seek(bar.ts);
  });

  const visible = () => !$('p2').hidden;
  const currentBar = () => (app.hasMap ? Math.floor(app.timeline.posOf(app.transport.playhead) / app.grid.barQ) : -1);

  const syncInputs = () => {
    setValue($in('num'), app.doc.meter.num);
    setValue($sel('den'), app.doc.meter.den);
    setValue($in('bpm'), +app.doc.tempo.baseBpm.toFixed(2));
    setValue($sel('grid'), app.beats.grid);
    // Only a straight grid finer than the beat has pairs of lines to swing.
    setValue($in('shuffle'), app.beats.shuffle);
    $in('shuffle').disabled = !swings(app.beats.grid, app.grid.beatQ);
    setText($('shuffleO'), app.beats.shuffle + '%');
    setValue($sel('snapTo'), app.beats.snapTo);
    setValue($sel('mapEvery'), app.beats.mapEvery);
    setValue($in('tol'), app.beats.tol);
    $('tolO').textContent = '±' + app.beats.tol + '%';
    $('aCount').textContent = app.doc.tempo.anchors.length ? plural(app.doc.tempo.anchors.length, 'pin') : '';
  };

  // The bar table. Rebuilt when the map settles (not on every frame of a drag).
  const renderTable = () => {
    if (!visible() || app.dragging) return;
    const out: string[] = [], cur = currentBar(), bars = app.bars;
    let prev: number | null = null, sum = 0;
    for (const bar of bars) {
      const d = prev == null ? null : bar.bpm - prev;
      const cls = d == null || Math.abs(d) < 0.005 ? '' : d > 0 ? 'up' : 'dn';
      out.push(`<tr data-b="${bar.b}"${bar.b === cur ? ' class="cur"' : ''}><td>${bar.b + 1}</td><td>${fmtTime(bar.ts)}</td><td>${bar.bpm.toFixed(2)}</td><td class="${cls}">${d == null ? '' : (d > 0 ? '+' : '') + d.toFixed(2)}</td></tr>`);
      prev = bar.bpm;
      sum += bar.bpm;
      if (out.length >= 1500) break;
    }
    rows.innerHTML = out.join('');
    if (bars.length) {
      const bp = bars.map((x) => x.bpm);
      $('sum').textContent = `${bars.length} bars · avg ${(sum / bars.length).toFixed(2)} · ${Math.min(...bp).toFixed(1)}–${Math.max(...bp).toFixed(1)}`;
    } else $('sum').textContent = '';
  };

  let lastHighlight = 0;
  const highlight = () => {
    if (!visible()) return;
    const n = performance.now();
    if (f.playback.playing && n - lastHighlight < 250) return;
    lastHighlight = n;
    const cur = currentBar(), old = rows.querySelector<HTMLElement>('.cur');
    if (old && +old.dataset.b! === cur) return;
    old?.classList.remove('cur');
    rows.querySelector(`tr[data-b="${cur}"]`)?.classList.add('cur');
  };

  app.bus.on(['doc', 'beats', 'audio'], syncInputs);
  app.bus.on(['doc', 'audio', 'step'], renderTable);
  app.bus.on('playhead', highlight);
  syncInputs();
}
