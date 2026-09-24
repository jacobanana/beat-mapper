// Warping: the audio re-timed so that the tempo map becomes a straight grid. No one way of stretching
// audio suits everything (Driedger & Müller, "A Review of Time-Scale Modification of Music Signals",
// Applied Sciences, 2016), so there is a mode per kind of material, each built on the method the
// literature finds best for it.
import { sliceWarp } from './beats';
import { type Progress, pow2For, throttle } from './frames';
import { hpss } from './hpss';
import { WarpMap } from './map';
import { phaseVocoder } from './pv';
import { repitch } from './repitch';
import { wsola } from './wsola';

export const WARP_MODES = ['beats', 'mono', 'vocal', 'poly', 'music', 'repitch'] as const;
export type WarpMode = (typeof WARP_MODES)[number];

export const WARP_MODE_INFO: Record<WarpMode, { label: string; desc: string }> = {
  beats: { label: 'Drums', desc: 'Cut at the transients, each hit moved whole: attacks stay exact. Sustained sounds step.' },
  mono: { label: 'Mono', desc: 'One note at a time (bass, lead, a single instrument): waveform-similarity overlap-add.' },
  vocal: { label: 'Vocal', desc: 'A voice: short waveform-similarity frames that keep consonants crisp and the formants in place.' },
  poly: { label: 'Poly', desc: 'Chords, pads, keys: a phase-locked phase vocoder. Smooth and in tune; attacks soften.' },
  music: { label: 'Full mix', desc: 'A whole song: harmonic and percussive parts split, each stretched its own way, added back.' },
  repitch: { label: 'Re-pitch', desc: 'Faster or slower like a turntable: no artefacts, but the pitch follows the tempo.' },
};

/** Everything a render needs, as plain data so it can be posted to a worker. */
export interface WarpJob {
  chans: Float32Array[];
  sr: number;
  /** The warp map's points, seconds. */
  src: number[];
  dst: number[];
  /** Output length, samples. */
  n: number;
  mode: WarpMode;
  /** Source seconds, sorted; where Drums mode cuts. */
  transients: number[];
  /** Drums mode fills its gaps. */
  fill?: boolean;
}

export function renderWarp(job: WarpJob, onProgress?: Progress): Float32Array[] {
  const { chans, sr, n } = job, w = new WarpMap(job.src, job.dst), p = throttle(onProgress);
  switch (job.mode) {
    case 'beats': return sliceWarp(chans, sr, w, n, { transients: job.transients, fill: job.fill }, p);
    // Frames hold two periods of a 40 Hz bass and may shift by half of one.
    case 'mono': return wsola(chans, sr, w, n, { frame: 0.05, tol: 0.0125 }, p);
    // A voice sits above 80 Hz, so shorter frames do, and smear consonants less.
    case 'vocal': return wsola(chans, sr, w, n, { frame: 0.03, tol: 0.0075 }, p);
    // About 93 ms: fine enough in frequency to part the notes of a chord.
    case 'poly': return phaseVocoder(chans, sr, w, n, { N: pow2For(0.093, sr) }, p);
    case 'repitch': return repitch(chans, sr, w, n, p);
    case 'music': {
      const { harmonic, percussive } = hpss(chans, { N: pow2For(0.046, sr) }, throttle(onProgress, 0, 0.35));
      const h = phaseVocoder(harmonic, sr, w, n, { N: pow2For(0.093, sr) }, throttle(onProgress, 0.35, 0.9));
      // Percussive frames of about 12 ms, laid down as they are: no search, so no hit is moved.
      const q = wsola(percussive, sr, w, n, { frame: 0.012, tol: 0 }, throttle(onProgress, 0.9, 1));
      for (let c = 0; c < h.length; c++) for (let i = 0; i < n; i++) h[c][i] += q[c][i];
      return h;
    }
  }
}
