// What each step hears, clicks, plays and lets you edit, in one table. Anything that differs by step
// reads it here rather than comparing step numbers, so the rules can't drift apart.
import { STEP, type Step } from '../state/steps';

export interface StepRules {
  /**
   * Hears the warp when the Warped switch is on, and cuts, measures and exports what it makes.
   * Transients and Beats never do: the warp is made from what they find.
   */
  hearsWarp: boolean;
  /** What the metronome clicks on: every transient, or the beats of the grid. */
  clicks: 'transients' | 'beats';
  /** The synth kit plays the drums found, where they are drawn. */
  kit: boolean;
  /** The synth voice plays the notes found. */
  synth: boolean;
  /** The upper half of the waveform edits (transients, pins, warp markers); below it scrolls. */
  editable: boolean;
  /** The transients recede behind the grid. */
  recede: boolean;
  /** Works against the grid, so bar 1 is set (on the first transient) on arriving. */
  needsBar1: boolean;
}

const RULES: Record<Step, StepRules> = {
  [STEP.transients]: { hearsWarp: false, clicks: 'transients', kit: false, synth: false, editable: true, recede: false, needsBar1: false },
  [STEP.beats]: { hearsWarp: false, clicks: 'beats', kit: false, synth: false, editable: true, recede: true, needsBar1: true },
  [STEP.warp]: { hearsWarp: true, clicks: 'beats', kit: false, synth: false, editable: true, recede: true, needsBar1: true },
  [STEP.slice]: { hearsWarp: true, clicks: 'transients', kit: false, synth: false, editable: false, recede: true, needsBar1: false },
  [STEP.groove]: { hearsWarp: true, clicks: 'beats', kit: true, synth: false, editable: false, recede: true, needsBar1: true },
  [STEP.notes]: { hearsWarp: true, clicks: 'beats', kit: false, synth: true, editable: false, recede: true, needsBar1: true },
};

export const stepRules = (step: Step): StepRules => RULES[step];
