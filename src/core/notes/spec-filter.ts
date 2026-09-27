// Filters for the spectrogram under the piano roll, to leave the notes and take out everything else:
// the drums, breath, hiss and the smear of an attack. Two kinds, either side of the view's algorithm.
//
// Before it, on the magnitudes: **steady** keeps what holds one pitch over time against what is broad
// in frequency (a harmonic-percussive split by median filters, Fitzgerald 2010), and **floor** takes
// off each frame's local noise floor, the median of the octave around each bin, so a note is drawn by
// how far it stands over what is around it rather than by how loud the mix is there.
//
// After it, on the dB the view gives: **even** draws each moment against the loudest in the two
// seconds around it, so a quiet verse is as bright as a loud chorus; **peaks** keeps only the bins louder than their neighbours, so
// a note is one line and not a smear; **minimum length** drops the lines shorter than a note lasts;
// and **semitones** draws each semitone at its loudest bin, so what is lit lines up with the rows.
import type { PitchSpectrogram } from './spectrogram';

export interface SpecFilter {
  /** 0 (off) to 100: how long a sound must hold its pitch to be kept over what is broad in frequency. */
  steady: number;
  /** 0 (off) to 30 dB: how far over the local noise floor a bin must stand to be drawn. */
  floor: number;
  /** Only the bins louder than their neighbours in frequency. */
  peaks: boolean;
  /** 0 (off) to 500 ms: lines shorter than this are dropped. */
  minLen: number;
  /** Each semitone drawn at its loudest bin, filling its row. */
  snap: boolean;
  /** Each moment drawn against the loudest around it rather than the loudest of the take. */
  even: boolean;
  /** 1 to 8: how many notes at once the notes-only view picks in each frame. */
  voices: number;
}

export const SPEC_FILTER_LIMITS = {
  steady: { min: 0, max: 100 },
  floor: { min: 0, max: 30 },
  minLen: { min: 0, max: 500 },
  voices: { min: 1, max: 8 },
} as const;

// As scored on BabySlakh's mixes (bench/spectrogram.eval.ts): the steady filter on is most of the
// gain, and how far it reaches hardly matters, so it reaches little; lines under 150 ms dropped keep
// what is lit to the notes at a wider range. The floor and peaks cost as many notes as they clear.
export const defaultSpecFilter = (): SpecFilter => ({ steady: 35, floor: 0, peaks: false, minLen: 150, snap: false, even: false, voices: 8 });

/** Whether the filters before the view do anything, so the spectrogram can be used as it is. */
export const preFilters = (f: SpecFilter): boolean => f.steady > 0 || f.floor > 0;
/** Whether the filters after the view do anything. */
export const postFilters = (f: SpecFilter): boolean => f.peaks || f.minLen > 0 || f.snap || f.even;

/**
 * The running median of a series, `half` values either side (fewer at the ends), into out. The window
 * is kept sorted as it slides, one value out and one in, rather than sorted again for each value.
 */
function runningMedian(x: Float32Array, half: number, out: Float32Array): void {
  const n = x.length, win = new Float32Array(2 * half + 1);
  let len = 0;
  const insert = (v: number) => {
    let i = len++;
    while (i > 0 && win[i - 1] > v) { win[i] = win[i - 1]; i--; }
    win[i] = v;
  };
  const remove = (v: number) => {
    let lo = 0, hi = len - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (win[m] < v) lo = m + 1; else hi = m; }
    win.copyWithin(lo, lo + 1, len--);
  };
  for (let i = 0; i < Math.min(n, half); i++) insert(x[i]);
  for (let i = 0; i < n; i++) {
    // Out before in: the window never holds more than it has room for.
    if (i - half - 1 >= 0) remove(x[i - half - 1]);
    if (i + half < n) insert(x[i + half]);
    out[i] = len & 1 ? win[len >> 1] : 0.5 * (win[(len >> 1) - 1] + win[len >> 1]);
  }
}

/** Each bin's median over `half` frames either side (time) or `half` bins either side (frequency). */
function medianFilter(s: PitchSpectrogram, half: number, alongTime: boolean): Float32Array {
  const { data, frames, bins } = s, out = new Float32Array(data.length);
  if (alongTime) {
    const x = new Float32Array(frames), y = new Float32Array(frames);
    for (let j = 0; j < bins; j++) {
      for (let n = 0; n < frames; n++) x[n] = data[n * bins + j];
      runningMedian(x, half, y);
      for (let n = 0; n < frames; n++) out[n * bins + j] = y[n];
    }
  } else {
    for (let n = 0; n < frames; n++) runningMedian(data.subarray(n * bins, (n + 1) * bins), half, out.subarray(n * bins, (n + 1) * bins));
  }
  return out;
}

/** The spectrogram with the steady and floor filters applied, the same shape and scale. */
export function preFilter(s: PitchSpectrogram, f: SpecFilter): PitchSpectrogram {
  if (!preFilters(f)) return s;
  const data = s.data.slice();
  if (f.steady > 0) {
    // Up to a second of frames for the time median; the frequency median spans four semitones,
    // wide enough that a partial (a bin or two) is never its own median, narrow enough to follow a
    // mix whose noise is louder in some octaves than others.
    const ht = Math.max(1, Math.round((f.steady / 100) * 0.5 * s.fr)), H = medianFilter(s, ht, true), P = medianFilter(s, 2 * s.perSemitone, false);
    for (let i = 0; i < data.length; i++) {
      const h = H[i] * H[i], p = P[i] * P[i];
      data[i] *= h + p > 0 ? h / (h + p) : 0;
    }
  }
  if (f.floor > 0) {
    // The octave around each bin, of what the steady filter left.
    const F = medianFilter({ ...s, data }, 6 * s.perSemitone, false), g = Math.pow(10, f.floor / 20);
    for (let i = 0; i < data.length; i++) data[i] = Math.max(0, data[i] - g * F[i]);
  }
  return { ...s, data };
}

/** The view with the even, peaks, minimum length and semitone filters applied. */
export function postFilter(s: PitchSpectrogram, V: Float32Array, f: SpecFilter): Float32Array {
  if (!postFilters(f)) return V;
  const { frames, bins, perSemitone: per } = s, floor = -200;
  let out = V;
  if (f.even) {
    // The loudest a frame gets, then the loudest of those a second either side; never more than 40 dB
    // under the take's loudest, so a silence isn't raised into its noise.
    const top = new Float32Array(frames), half = Math.round(s.fr);
    for (let n = 0; n < frames; n++) { let m = -40; for (let j = 0; j < bins; j++) if (V[n * bins + j] > m) m = V[n * bins + j]; top[n] = m; }
    out = new Float32Array(V.length);
    for (let n = 0; n < frames; n++) {
      let ref = -40;
      for (let m = Math.max(0, n - half); m <= Math.min(frames - 1, n + half); m++) if (top[m] > ref) ref = top[m];
      for (let j = 0; j < bins; j++) out[n * bins + j] = V[n * bins + j] - ref;
    }
  }
  if (f.peaks) {
    const W = out;
    // A bin at least as loud as the two either side of it: one peak a semitone at most, and a note
    // bent or vibrating still draws its line through whichever bin it is in.
    out = new Float32Array(V.length).fill(floor);
    for (let n = 0; n < frames; n++) {
      const r = n * bins;
      for (let j = 0; j < bins; j++) {
        const v = W[r + j];
        let peak = true;
        for (let k = Math.max(0, j - 2); k <= Math.min(bins - 1, j + 2) && peak; k++) if (k !== j && W[r + k] > v) peak = false;
        if (peak) out[r + j] = v;
      }
    }
  }
  if (f.minLen > 0) {
    // A line is the bins lit frame after frame within a bin of each other; one lasting less than the
    // minimum is taken out. Lit is down to 60 dB, whatever the range: a note is followed through its
    // quiet start and end, and the range can be moved without redoing this.
    const need = Math.max(2, Math.round((f.minLen / 1000) * s.fr)), lit = new Uint8Array(V.length), near = new Uint8Array(V.length);
    for (let i = 0; i < out.length; i++) lit[i] = out[i] > -60 ? 1 : 0;
    for (let n = 0; n < frames; n++) {
      const r = n * bins;
      for (let j = 0; j < bins; j++) near[r + j] = lit[r + j] | (j > 0 ? lit[r + j - 1] : 0) | (j + 1 < bins ? lit[r + j + 1] : 0);
    }
    const kept = out === V ? V.slice() : out;
    for (let j = 0; j < bins; j++) {
      for (let n = 0; n < frames;) {
        if (!near[n * bins + j]) { n++; continue; }
        let m = n;
        while (m < frames && near[m * bins + j]) m++;
        if (m - n < need) for (let k = n; k < m; k++) kept[k * bins + j] = floor;
        n = m;
      }
    }
    out = kept;
  }
  if (f.snap) {
    const snapped = out === V ? V.slice() : out;
    for (let n = 0; n < frames; n++) {
      for (let j = 0; j + per <= bins; j += per) {
        const r = n * bins + j;
        let m = snapped[r];
        for (let k = 1; k < per; k++) if (snapped[r + k] > m) m = snapped[r + k];
        for (let k = 0; k < per; k++) snapped[r + k] = m;
      }
    }
    out = snapped;
  }
  return out;
}
