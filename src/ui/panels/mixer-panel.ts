// The mixer: a popover under the transport with a level for the audio, the click and the synth kit,
// the click's on/off, and what the Groove step plays.
import type { App } from '../../app/app';
import type { Features } from '../../app/features';
import { MIX_CHANNELS, type GrooveListen } from '../../state/settings';
import { $, $in, $sel, setPressed, setText, setValue } from '../dom';

export function bindMixerPanel(app: App, f: Features): void {
  const pop = $('mixer'), btn = $('mixBtn');
  const show = (open: boolean) => {
    pop.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    btn.classList.toggle('on', open);
  };
  btn.onclick = () => show(btn.getAttribute('aria-expanded') !== 'true');
  // Closes on a press anywhere else, or Escape, so it never sits over the waveform by accident.
  document.addEventListener('pointerdown', (e) => {
    const t = e.target as Node;
    if (!pop.hidden && !pop.contains(t) && !btn.contains(t)) show(false);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !pop.hidden) show(false); });

  for (const ch of MIX_CHANNELS) $in('mix-' + ch).oninput = (e) => f.mixer.setLevel(ch, +(e.target as HTMLInputElement).value);
  $('clickBtn').onclick = () => f.playback.toggleClick();
  $sel('gListen').onchange = (e) => f.groove.setListen((e.target as HTMLSelectElement).value as GrooveListen);

  const syncLevels = () => {
    for (const ch of MIX_CHANNELS) {
      setValue($in('mix-' + ch), app.mix[ch]);
      setText($('mixO-' + ch), app.mix[ch] + '%');
    }
  };
  // The kit only plays in the Groove step, once the drums are found; elsewhere its row says so.
  const syncDrums = () => {
    const live = app.step === 5 && !!app.drums;
    setValue($sel('gListen'), app.groove.listen);
    $('mixDrums').classList.toggle('idle', !live);
    $('mixHint').hidden = live;
  };
  // The mixer button lights up while the click is on, since the click's own button is inside.
  const syncClick = () => {
    setPressed($('clickBtn'), app.transport.click);
    btn.classList.toggle('live', app.transport.click);
  };
  app.bus.on('mix', syncLevels);
  app.bus.on(['groove', 'step', 'drums'], syncDrums);
  app.bus.on('transport', syncClick);
  syncLevels();
  syncDrums();
  syncClick();
}
