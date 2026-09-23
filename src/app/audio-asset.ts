import { PeakPyramid, mixToMono, peakOf } from '../core/dsp/peaks';

/** The audio being worked on: decoded channels, a mono mix for analysis and drawing, and its peaks. */
export interface AudioAsset {
  /** Display name: the file name without its extension. */
  readonly name: string;
  readonly fileName: string;
  /** The original file, when there is one (not for the demo); packed into REAPER zips as is. */
  readonly file: File | null;
  readonly buffer: AudioBuffer;
  readonly sr: number;
  readonly dur: number;
  readonly chans: readonly Float32Array[];
  readonly x: Float32Array;
  /** Loudest sample of the mono mix, for scaling the waveform. */
  readonly peak: number;
  readonly peaks: PeakPyramid;
}

export function makeAsset(buffer: AudioBuffer, chans: Float32Array[], name: string, fileName: string, file: File | null): AudioAsset {
  const x = mixToMono(chans);
  return { name, fileName, file, buffer, sr: buffer.sampleRate, dur: buffer.duration, chans, x, peak: peakOf(x) || 1, peaks: new PeakPyramid(x) };
}
