// Step 3 – Warp: what plays (warped or the original), the grid tempo and where it comes from, the
// grid transients are lined up on, what is warped, and the material. The same settings as the Export window's warped .wav.
import type { App } from '../../app/app';
import type { Features } from '../../app/features';
import type { GridDivision } from '../../core/tempo/meter';
import { WARP_MODES, type WarpMode } from '../../core/warp/modes';
import { $, $btn, $in, $sel, setPressed, setText, setValue } from '../dom';

export function bindWarpPanel(app: App, f: Features, refocus: () => void): void {
  const w = f.warp;
  $('wOrig').onclick = () => w.setListen(false);
  $('wWarped').onclick = () => w.setListen(true);
  $('wFromLoop').onclick = () => w.fromLoop();
  // The same grid as Beats: one setting, drawn in both steps.
  $sel('warpGrid').onchange = (e) => f.beats.setGrid((e.target as HTMLSelectElement).value as GridDivision);
  $('wQuantize').onclick = () => w.quantize();
  $('wClearMarkers').onclick = () => w.clearMarkers();
  $sel('warpRange').onchange = (e) => w.setRange((e.target as HTMLSelectElement).value === 'loop' ? 'loop' : 'file');
  $sel('warpModeB').onchange = (e) => w.setMode((e.target as HTMLSelectElement).value as WarpMode);
  $in('warpBpmB').onchange = (e) => {
    const s = (e.target as HTMLInputElement).value.trim(), v = +s;
    w.update({ bpm: s !== '' && Number.isFinite(v) && v >= 20 && v <= 400 ? v : null });
    refocus();
  };

  const sync = () => {
    const s = app.warp, p = w.plan();
    setPressed($('wOrig'), !s.listen);
    setPressed($('wWarped'), s.listen);
    $btn('wFromLoop').disabled = !app.transport.loop;
    setValue($sel('warpGrid'), app.beats.grid);
    $btn('wQuantize').disabled = !p;
    $btn('wClearMarkers').disabled = !app.doc.warpMarkers.length;
    setValue($sel('warpRange'), s.range);
    if ((WARP_MODES as readonly string[]).includes(s.mode)) setValue($sel('warpModeB'), s.mode);
    const bpm = $in('warpBpmB');
    if (document.activeElement !== bpm) bpm.value = s.bpm == null ? '' : String(s.bpm);
    bpm.placeholder = p ? String(Math.round(p.avgBpm)) : '';
    setText($('wSum'), w.summary());
  };
  app.bus.on(['warp', 'doc', 'transport', 'audio', 'export', 'beats'], sync);
  sync();
}
