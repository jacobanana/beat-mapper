// Settings: what the controls are set to. Saved with the session, but not part of undo.
import type { Algo, Band } from '../core/dsp/onset';
import type { MapSettings } from '../core/beats/edit';
import type { DrumSource } from '../core/drums/detect';
import type { PerVoice } from '../core/drums/voices';
import type { GrooveGrid, Reference } from '../core/groove/pocket';
import type { GridDivision } from '../core/tempo/meter';
import type { TimeRange } from '../core/types';
import type { TempoResolution } from '../io/formats/midi';

export interface DetectionSettings {
  /** 0..100 */
  sens: number;
  /** Minimum gap between markers, ms. */
  gap: number;
  band: Band;
  algo: Algo;
  /** Draw the detection function over the waveform. */
  showOdf: boolean;
}

/** What the playhead and drags land on. */
export type SnapMode = 'markers' | 'grid' | 'off';
export const SNAP_MODES: readonly SnapMode[] = ['markers', 'grid', 'off'];

export interface BeatSettings extends MapSettings {
  grid: GridDivision;
  snapTo: SnapMode;
  /** Bars in the loop for derive-from-loop; null works it out. Not saved. */
  loopBars: number | null;
}

export interface ExportSettings {
  lead: 'full' | 'trim';
  res: TempoResolution;
  clicks: boolean;
  /** Pack the audio file into the REAPER zip. */
  rppAudio: boolean;
}

export interface SlicerSettings {
  mode: 'gap' | 'fixed';
  /** ms */
  len: number;
  /** ms */
  tail: number;
  /** ms */
  fadeIn: number;
  /** ms */
  fadeOut: number;
  /** ms */
  min: number;
  mono: boolean;
  bits: 16 | 24;
  norm: boolean;
  /** dBFS */
  target: number;
  naming: 'num' | 'time';
  /** Add a .csv to the zip. */
  csv: boolean;
}

export interface TransportState {
  loop: TimeRange | null;
  loopOn: boolean;
  /** Where play returns to on stop: the blue flag. */
  start: number;
  playhead: number;
  /** Stop leaves the playhead where it stopped. */
  stay: boolean;
  /** Metronome clicks on markers or beats. */
  click: boolean;
  scrubMode: boolean;
}

export interface GrooveSettings {
  /** A drum stem or loop, or a full mix. */
  source: DrumSource;
  /** Per voice, 0..100. */
  sens: PerVoice<number>;
  grid: GrooveGrid;
  ref: Reference | 'auto';
  /** Draw offsets three times their size, as Pocket Science's pocket-emphasis mode does. */
  exaggerate: boolean;
  /** The chart under the controls: the pocket, or the hits as a MIDI transcript. */
  chart: GrooveChartMode;
}

/** How loud each thing that plays is, in percent of its natural level: 100 is as it always was. */
export interface MixSettings {
  audio: number;
  click: number;
  /** The synth kit playing the drums the Groove step found. */
  drums: number;
}

export const MIX_CHANNELS = ['audio', 'click', 'drums'] as const;

/**
 * What the mixer has muted, keeping each level for when it comes back. The click has no mute here:
 * its on/off in the transport is its mute. The kit starts muted, so the Groove step sounds like the
 * audio until asked otherwise.
 */
export interface MuteSettings {
  audio: boolean;
  drums: boolean;
}
export const MIX_MAX = 150;

export type GrooveChartMode = 'pocket' | 'midi';

export const defaultDetection = (): DetectionSettings => ({ sens: 55, gap: 60, band: 'full', algo: 'flux', showOdf: true });
export const defaultBeats = (): BeatSettings => ({ grid: '16', mapEvery: 'beat', tol: 20, snapTo: 'markers', loopBars: null });
export const defaultExport = (): ExportSettings => ({ lead: 'full', res: 'pins', clicks: true, rppAudio: true });
export const defaultSlicer = (): SlicerSettings => ({
  mode: 'gap', len: 500, tail: 0, fadeIn: 1, fadeOut: 8, min: 40, mono: false, bits: 16, norm: false, target: -1, naming: 'num', csv: true,
});
export const defaultTransport = (): TransportState => ({ loop: null, loopOn: false, start: 0, playhead: 0, stay: false, click: false, scrubMode: false });
export const defaultGroove = (): GrooveSettings => ({ source: 'drums', sens: { kick: 55, snare: 55, hat: 55 }, grid: '16', ref: 'auto', exaggerate: true, chart: 'pocket' });
export const defaultMix = (): MixSettings => ({ audio: 100, click: 100, drums: 100 });
export const defaultMute = (): MuteSettings => ({ audio: false, drums: true });

/** Reads mixer levels saved by an earlier visit, keeping only numbers in range. */
export function parseMix(json: string | null): MixSettings {
  const m = defaultMix();
  try {
    const d = json ? JSON.parse(json) : null;
    for (const k of MIX_CHANNELS) {
      const v = d?.[k];
      if (typeof v === 'number' && Number.isFinite(v)) m[k] = Math.max(0, Math.min(MIX_MAX, Math.round(v)));
    }
  } catch {}
  return m;
}
