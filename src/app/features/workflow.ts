// The steps: Transients, Beats, Slice, Groove. Step 3 was Export, which is a window now.
import type { Step } from '../../io/session';
import type { App } from '../app';
import type { Beats } from './beats';
import type { Groove } from './groove';

export class Workflow {
  constructor(private readonly app: App, private readonly beats: Beats, private readonly groove: Groove) {}

  goTo(step: Step): void {
    // Export is a window now, not a step; a session saved in it comes back in Beats.
    if (step === 3) step = 2;
    if (step > 1 && !this.app.audio) return this.app.notify.toast('Open an audio file first.');
    // Beats and Groove need bar 1; it starts on the first transient.
    if (step === 2 || step === 5) this.beats.ensureDownbeat();
    this.app.setStep(step);
    if (step === 5) void this.groove.ensureDrums();
  }
}
