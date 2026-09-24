// Step 3 – Warp: the grid tempo and where it comes from, the grid transients are lined up on, what
// is warped, and the material. The Export window's warped .wav is made from these, and only says how
// the file is written. Whether it is heard is the Warped switch in the top bar, since Slice and Groove
// follow it too.
import type { App } from '../../app/app';
import type { Features } from '../../app/features';
import { type GridDivision, swings } from '../../core/tempo/meter';
import { WARP_MODES, type WarpMode } from '../../core/warp/modes';
import { $, $btn, $in, $sel, setPressed, setText, setValue } from '../dom';

export function bindWarpPanel(app: App, f: Features, refocus: () => void): void {
  const w = f.warp;
  $('wFromLoop').onclick = () => w.fromLoop();
  // The same grid as Beats: one setting, drawn in both steps.
  $sel('warpGrid').onchange = (e) => f.beats.setGrid((e.target as HTMLSelectElement).value as GridDivision);

  // Quantize is how far every transient moves to its grid line. The warp follows each move of it, the
  // shuffle or the grid, and what plays is rendered again once they settle.
  const strength = $in('qStrength');
  strength.oninput = () => w.setQuantizeStrength(+strength.value);
  $in('warpShuffle').oninput = (e) => f.beats.setShuffle(+(e.target as HTMLInputElement).value);
  $sel('warpRange').onchange = (e) => w.setRange((e.target as HTMLSelectElement).value === 'loop' ? 'loop' : 'file');
  $sel('warpModeB').onchange = (e) => w.setMode((e.target as HTMLSelectElement).value as WarpMode);
  // Only Drums mode cuts, so only it leaves gaps to fill.
  $('wFill').onclick = () => { w.setFill(!app.warp.fill); refocus(); };
  $in('warpBpmB').onchange = (e) => {
    const s = (e.target as HTMLInputElement).value.trim(), v = +s;
    w.update({ bpm: s !== '' && Number.isFinite(v) && v >= 20 && v <= 400 ? v : null });
    refocus();
  };

  const sync = () => {
    const s = app.warp, p = w.plan();
    $btn('wFromLoop').disabled = !app.transport.loop;
    setValue($sel('warpGrid'), app.beats.grid);
    // Only a straight grid finer than the beat has pairs of lines to swing.
    setValue($in('warpShuffle'), app.beats.shuffle);
    $in('warpShuffle').disabled = !swings(app.beats.grid, app.grid.beatQ);
    setText($('warpShuffleO'), app.beats.shuffle + '%');
    strength.disabled = !p;
    setValue(strength, s.quantize);
    setText($('qStrengthO'), s.quantize + '%');
    setValue($sel('warpRange'), s.range);
    if ((WARP_MODES as readonly string[]).includes(s.mode)) setValue($sel('warpModeB'), s.mode);
    $btn('wFill').disabled = s.mode !== 'beats' || !p;
    setPressed($btn('wFill'), s.fill);
    const bpm = $in('warpBpmB');
    if (document.activeElement !== bpm) bpm.value = s.bpm == null ? '' : String(s.bpm);
    bpm.placeholder = p ? String(Math.round(p.avgBpm)) : '';
    setText($('wSum'), w.summary());
  };
  app.bus.on(['warp', 'doc', 'transport', 'audio', 'export', 'beats', 'heard'], sync);
  sync();
}
