// The session: the work on this audio, saved to a file or opened from one. It sits beside Open, not in
// the Export window, because it is the work itself rather than something a step makes, and it is wanted
// from every step. A popover under its button, like the mixer.
import type { App } from '../../app/app';
import type { Features } from '../../app/features';
import { $, $btn, $in } from '../dom';

export function bindSessionPanel(app: App, f: Features, onPick: (e: Event) => void): void {
  const pop = $('sessPop'), btn = $('sessBtn');
  const show = (open: boolean) => {
    pop.hidden = !open;
    // Hangs under its button, kept on screen.
    if (open) {
      const r = btn.getBoundingClientRect(), bar = pop.offsetParent!.getBoundingClientRect(), w = pop.offsetWidth;
      pop.style.left = Math.max(8, Math.min(bar.width - w - 8, r.left - bar.left)) + 'px';
      pop.style.right = 'auto';
    }
    btn.setAttribute('aria-expanded', String(open));
    btn.classList.toggle('on', open);
  };
  btn.onclick = () => show(btn.getAttribute('aria-expanded') !== 'true');
  document.addEventListener('pointerdown', (e) => {
    const t = e.target as Node;
    if (!pop.hidden && !pop.contains(t) && !btn.contains(t)) show(false);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !pop.hidden) show(false); });

  $('sessSave').onclick = () => { show(false); void f.sessions.export(); };
  const input = $in('sessIn');
  input.addEventListener('change', (e) => { show(false); onPick(e); });
  if (matchMedia('(pointer:fine)').matches) input.accept = '.json,application/json';
  $('sessOpen').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); input.click(); }
  });

  // A session is saved for the audio it belongs to, so there is nothing to save before some is open.
  const sync = () => { $btn('sessSave').disabled = !app.audio; };
  app.bus.on('audio', sync);
  sync();
}
