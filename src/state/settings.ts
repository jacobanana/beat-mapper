// Settings: what the controls are set to. Saved with the session, but not part of undo.
import type { Algo, Band } from '../core/dsp/onset';
import type { MapSettings } from '../core/beats/edit';
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

export const defaultDetection = (): DetectionSettings => ({ sens: 55, gap: 60, band: 'full', algo: 'flux', showOdf: true });
export const defaultBeats = (): BeatSettings => ({ grid: '16', mapEvery: 'beat', tol: 20, snapTo: 'markers', loopBars: null });
export const defaultExport = (): ExportSettings => ({ lead: 'full', res: 'pins', clicks: true, rppAudio: true });
export const defaultSlicer = (): SlicerSettings => ({
  mode: 'gap', len: 500, tail: 0, fadeIn: 1, fadeOut: 8, min: 40, mono: false, bits: 16, norm: false, target: -1, naming: 'num', csv: true,
});
export const defaultTransport = (): TransportState => ({ loop: null, loopOn: false, start: 0, playhead: 0, stay: false, click: false, scrubMode: false });
