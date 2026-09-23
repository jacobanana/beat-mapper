// The four steps: Transients, Beats, Export, Slice.
import type { Step } from '../../io/session';
import type { App } from '../app';
import type { Beats } from './beats';

export class Workflow {
  constructor(private readonly app: App, private readonly beats: Beats) {}

  goTo(step: Step): void {
    if (step > 1 && !this.app.audio) return this.app.notify.toast('Open an audio file first.');
    // Beats and Export need bar 1; it starts on the first transient.
    if (step === 2 || step === 3) this.beats.ensureDownbeat();
    this.app.setStep(step);
  }
}
