import type { Notifier } from '../app/app';
import { $ } from './dom';

/** Toasts at the bottom, and the progress overlay over the waveform. */
export class DomNotifier implements Notifier {
  private timer: ReturnType<typeof setTimeout> | null = null;

  toast(msg: string): void {
    const el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  busy(text: string, fraction: number): void {
    $('busy').hidden = false;
    $('busyText').textContent = text;
    $('busyBar').style.width = Math.round((fraction || 0) * 100) + '%';
  }

  idle(): void {
    $('busy').hidden = true;
  }
}
