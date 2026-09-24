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

  // Quantize applies at once and opens its strength beside it; moving the slider quantizes again, as
  // the same undo step, until the popover closes.
  const pop = $('qPop'), qBtn = $btn('wQuantize'), strength = $in('qStrength');
  const show = (open: boolean) => {
    pop.hidden = !open;
    qBtn.setAttribute('aria-expanded', String(open));
    qBtn.classList.toggle('on', open);
    if (!open) return w.endQuantize();
    // Under the button when there is room, else over it (the panel sits at the bottom of the screen), kept on screen.
    const r = qBtn.getBoundingClientRect(), pw = pop.offsetWidth, ph = pop.offsetHeight;
    pop.style.left = Math.max(8, Math.min(innerWidth - pw - 8, r.left)) + 'px';
    pop.style.top = (r.bottom + 4 + ph <= innerHeight - 8 ? r.bottom + 4 : Math.max(8, r.top - 4 - ph)) + 'px';
  };
  qBtn.onclick = () => {
    if (!pop.hidden) return show(false);
    if (w.quantize()) show(true);
  };
  strength.oninput = () => w.setQuantizeStrength(+strength.value);
  $('qDone').onclick = () => { show(false); refocus(); };
  document.addEventListener('pointerdown', (e) => {
    const t = e.target as Node;
    if (!pop.hidden && !pop.contains(t) && !qBtn.contains(t)) show(false);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !pop.hidden) show(false); });
  // Another edit (an undo, a dragged transient) ends the quantize the slider was changing.
  app.bus.on(['doc', 'step'], () => { if (!pop.hidden && (!w.quantizeOpen || app.step !== 3)) show(false); });
  // A new grid while the strength is open lines the transients up on it instead.
  app.bus.on('beats', () => { if (!pop.hidden) w.requantize(); });
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
    setValue(strength, s.quantize);
    setText($('qStrengthO'), s.quantize + '%');
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
