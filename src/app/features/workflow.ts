// The steps: Transients, Beats, Warp, Slice, Groove.
import { STEP, type Step } from '../../state/steps';
import { stepRules } from '../steps';
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
      case STEP.transients: return this.markers.changed;
      case STEP.beats: return this.beats.changed;
      case STEP.warp: return this.warp.changed;
      case STEP.slice: return this.slicer.changed;
      case STEP.groove: return this.groove.changed;
      default: return false;
    }
  }

  /** Starts the current step again, as it was on arriving. */
  resetStep(): void {
    switch (this.app.step) {
      case STEP.transients: void this.markers.reset(); break;
      case STEP.beats: this.beats.reset(); break;
      case STEP.warp: this.warp.reset(); break;
      case STEP.slice: this.slicer.reset(); break;
      case STEP.groove: this.groove.reset(); break;
    }
  }

  goTo(step: Step): void {
    if (step !== STEP.transients && !this.app.audio) return this.app.notify.toast('Open an audio file first.');
    // Bar 1 starts on the first transient.
    if (stepRules(step).needsBar1) this.beats.ensureDownbeat();
    this.app.setStep(step);
    if (step === STEP.warp && this.app.doc.tempo.anchors.length < 2) this.app.notify.toast('Only bar 1 is pinned: the map is one steady tempo. Map the beats in step 2 so the warp can straighten them.');
    if (step === STEP.groove) void this.groove.ensureDrums();
  }
}
