// The steps: Transients, Beats, Warp, Slice, Groove.
import type { Step } from '../../io/session';
import type { App } from '../app';
import type { Beats } from './beats';
import type { Groove } from './groove';
import type { Markers } from './markers';
import type { Slicer } from './slicer';
import type { Warp } from './warp';

export class Workflow {
  constructor(
    private readonly app: App,
    private readonly markers: Markers,
    private readonly beats: Beats,
    private readonly slicer: Slicer,
    private readonly warp: Warp,
    private readonly groove: Groove,
  ) {}

  /** Whether the current step has anything to reset. */
  get canReset(): boolean {
    switch (this.app.step) {
      case 1: return this.markers.changed;
      case 2: return this.beats.changed;
      case 3: return this.warp.changed;
      case 4: return this.slicer.changed;
      case 5: return this.groove.changed;
      default: return false;
    }
  }

  /** Starts the current step again, as it was on arriving. */
  resetStep(): void {
    switch (this.app.step) {
      case 1: void this.markers.reset(); break;
      case 2: this.beats.reset(); break;
      case 3: this.warp.reset(); break;
      case 4: this.slicer.reset(); break;
      case 5: this.groove.reset(); break;
    }
  }

  goTo(step: Step): void {
    if (step > 1 && !this.app.audio) return this.app.notify.toast('Open an audio file first.');
    // Beats, Warp and Groove need bar 1; it starts on the first transient.
    if (step === 2 || step === 3 || step === 5) this.beats.ensureDownbeat();
    this.app.setStep(step);
    if (step === 3 && this.app.doc.tempo.anchors.length < 2) this.app.notify.toast('Only bar 1 is pinned: the map is one steady tempo. Map the beats in step 2 so the warp can straighten them.');
    if (step === 5) void this.groove.ensureDrums();
  }
}
