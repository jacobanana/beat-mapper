// The mixer: a popover under its button with a level for the audio, the click, the synth kit and the
// synth voice. Each
// channel's icon mutes it; the click's is the same on/off as the transport's, which stays one tap away.
import type { App } from '../../app/app';
import type { Features } from '../../app/features';
import { MIX_CHANNELS } from '../../state/settings';
import { $, $in, setPressed, setText, setValue } from '../dom';

export function bindMixerPanel(app: App, f: Features): void {
  const pop = $('mixer'), btn = $('mixBtn');
  const show = (open: boolean) => {
    pop.hidden = !open;
    // Hangs under its button, kept on screen: the button sits mid-bar on a desktop, at the edge on a phone.
    if (open) {
      const r = btn.getBoundingClientRect(), bar = pop.offsetParent!.getBoundingClientRect(), w = pop.offsetWidth;
      pop.style.left = Math.max(8, Math.min(bar.width - w - 8, r.right - bar.left - w)) + 'px';
    }
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
  for (const ch of MIX_CHANNELS) $('mute-' + ch).onclick = () => f.mixer.toggleMute(ch);

  const syncLevels = () => {
    for (const ch of MIX_CHANNELS) {
      setValue($in('mix-' + ch), app.mix[ch]);
      setText($('mixO-' + ch), app.mix[ch] + '%');
    }
  };
  const syncMutes = () => { for (const ch of MIX_CHANNELS) setPressed($('mute-' + ch), f.mixer.isOn(ch)); };
  // The kit only plays in the Groove step, once the drums are found; elsewhere its row says so.
  const syncDrums = () => {
    const live = f.playback.kitLive;
    $('mixDrums').classList.toggle('idle', !live);
    $('mixHint').hidden = live;
  };
  app.bus.on('mix', syncLevels);
  app.bus.on(['mute', 'transport'], syncMutes);
  app.bus.on(['step', 'drums'], syncDrums);
  // The same for the synth voice, in the Notes step once the notes are found.
  const syncNotes = () => {
    const live = f.playback.synthLive;
    $('mixNotes').classList.toggle('idle', !live);
    $('mixNotesHint').hidden = live;
  };
  app.bus.on(['step', 'transcript'], syncNotes);
  syncLevels();
  syncMutes();
  syncDrums();
  syncNotes();
}
