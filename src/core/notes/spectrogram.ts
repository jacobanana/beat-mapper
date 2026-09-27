// The spectrogram under the piano roll: what sounds at each pitch, frame by frame, on the roll's own
// axis (three bins a semitone from A0 to C8), so a note can be seen where it is played and drawn there
// by hand. The other way from audio to MIDI: the detectors decide, this shows and the user decides.
//
// Each FFT bin's energy is put at the frequency it really holds, read from how its phase moved since
// the last frame (the instantaneous frequency, as a phase vocoder measures it), rather than at the
// bin's own centre. A steady partial then lands in one narrow bin of the log axis instead of being
// smeared over the width of the window's lobe, which is what makes the fundamentals legible as lines.
// Two window lengths, as the chord detector uses: a long one under 400 Hz, where the low notes need
// the frequency resolution, and a short one above, where the attacks need the time resolution.
import { makeFFT } from '../dsp/fft';
import { decimate } from './common';

/** The lowest and highest pitch of the spectrogram, MIDI numbers: A0 to C8. */
export const SPEC_LO = 21, SPEC_HI = 108;
/** Bins a semitone; the middle one is centred on the note. */
export const SPEC_PER = 3;

export interface PitchSpectrogram {
  /** Magnitudes, frame after frame, `bins` values each. */
  readonly data: Float32Array;
  readonly frames: number;
  readonly bins: number;
  /** Bin j spans pitches `lo - 0.5 + j / perSemitone` to `lo - 0.5 + (j + 1) / perSemitone`. */
  readonly lo: number;
  readonly perSemitone: number;
  /** Frames per second. Frame n is the window centred on n / fr seconds. */
  readonly fr: number;
}

export interface PitchSpectrogramOptions {
  onProgress?: (fraction: number) => void;
  yieldToEventLoop?: boolean;
}

/** Window lengths, samples at the decimated rate, and the frequency each is used up to. */
const SIZES = [{ N: 2048, upTo: 400 }, { N: 1024, upTo: Infinity }];
/** A frame every 256 samples: 23 ms at 11 kHz. */
const HOP = 256;

/** Where a frequency sits on the bin axis: bin j's centre is at j. */
const binAt = (f: number): number => (12 * Math.log2(f / 440) + 69 - SPEC_LO + 0.5) * SPEC_PER - 0.5;

export async function pitchSpectrogram(x: Float32Array, sr0: number, o: PitchSpectrogramOptions = {}): Promise<PitchSpectrogram> {
  const { onProgress, yieldToEventLoop = true } = o;
  // Pitch lives under 4.2 kHz (C8), so a quarter of the samples is a quarter of the work.
  const { y, sr } = decimate(x, sr0, 11025);
  const frames = Math.max(1, Math.ceil(y.length / HOP)), bins = (SPEC_HI - SPEC_LO + 1) * SPEC_PER;
  const data = new Float32Array(frames * bins);
  const sizes = SIZES.map((z, s) => {
    const df = sr / z.N, from = s === 0 ? 0 : SIZES[s - 1].upTo, upTo = Math.min(z.upTo, 0.5 * sr);
    // The bins read: the region this size covers, with a margin for how far a bin's energy can move.
    return {
      N: z.N, df, from, upTo, fft: makeFFT(z.N),
      win: Float64Array.from({ length: z.N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / z.N)),
      re: new Float64Array(z.N), im: new Float64Array(z.N), phase: new Float64Array(z.N / 2),
      k0: Math.max(1, Math.floor((from / df) * 0.6)), k1: Math.min(z.N / 2 - 1, Math.ceil((upTo / df) * 1.5)),
      // A steady sinusoid of amplitude A reads about A (a Hann window sums to N/2).
      scale: (4 / z.N) * (4 / z.N),
      // Phase turned per hop by a bin's own frequency, and how many bins a radian of deviation is.
      turn: (2 * Math.PI * HOP) / z.N, perRad: z.N / (2 * Math.PI * HOP),
    };
  });
  // The frame before the first sets the phases; nothing is kept from it.
  for (let n = -1; n < frames; n++) {
    const row = n * bins;
    for (const z of sizes) {
      const { N, re, im, win } = z, st = n * HOP - N / 2;
      for (let i = 0; i < N; i++) { const k = st + i; re[i] = k >= 0 && k < y.length ? y[k] * win[i] : 0; im[i] = 0; }
      z.fft(re, im);
      for (let k = z.k0; k <= z.k1; k++) {
        const ph = Math.atan2(im[k], re[k]);
        let d = ph - z.phase[k] - k * z.turn;
        z.phase[k] = ph;
        if (n < 0) continue;
        d -= 2 * Math.PI * Math.round(d / (2 * Math.PI));
        // A bin under a partial's lobe points at the partial, from at most a bin away; one pointing
        // further is noise or an attack, and is left where it is rather than scattered.
        const dev = d * z.perRad, f = (k + (Math.abs(dev) <= 1.2 ? dev : 0)) * z.df;
        if (f < z.from || f >= z.upTo) continue;
        // Split between the two bins around it, so a note a few cents off a bin's edge draws one
        // steady line rather than flickering between the two.
        const b = binAt(f), j = Math.floor(b), r = b - j, e = (re[k] * re[k] + im[k] * im[k]) * z.scale;
        if (j >= 0 && j < bins) data[row + j] += e * (1 - r);
        if (j + 1 >= 0 && j + 1 < bins) data[row + j + 1] += e * r;
      }
    }
    if ((n & 1023) === 1023 && onProgress) {
      onProgress(Math.min(1, n / frames));
      if (yieldToEventLoop) await new Promise((r) => setTimeout(r, 0));
    }
  }
  for (let i = 0; i < data.length; i++) data[i] = Math.sqrt(data[i]);
  return { data, frames, bins, lo: SPEC_LO, perSemitone: SPEC_PER, fr: sr / HOP };
}

/**
 * How the spectrogram is shown: as heard; the fundamentals, each note lit where it is played and dim
 * where its partials are; with the harmonics taken out, each note's partials subtracted from the
 * bins above it; or the notes only, the few most likely in each frame and nothing else.
 */
export const SPEC_VIEWS = ['audio', 'fundamental', 'clean', 'notes'] as const;
export type SpecView = (typeof SPEC_VIEWS)[number];

/** The fewest and most partials a view takes as one note. */
export const HARMONICS_RANGE = { min: 1, max: 16 } as const;

/** How many bins up the h-th partial of a note sits. */
const partialOffset = (h: number): number => Math.round(12 * Math.log2(h) * SPEC_PER);

/** The loudest bin of the take. */
function peak(data: Float32Array): number {
  let m = 0;
  for (let i = 0; i < data.length; i++) if (data[i] > m) m = data[i];
  return m || 1;
}

/** Each bin in dB under the loudest of the take (0), floored at -120. */
function toDb(data: Float32Array, ref: number): Float32Array {
  const out = new Float32Array(data.length), k = 20 / Math.LN10, floor = ref * 1e-6;
  for (let i = 0; i < data.length; i++) out[i] = k * Math.log(Math.max(floor, data[i]) / ref);
  return out;
}

/**
 * The spectrogram as one view shows it, in dB under the loudest bin of the take, frame after frame.
 * `harmonics` is how many partials a note is taken to have, the first included.
 */
export function viewSpectrogram(s: PitchSpectrogram, view: SpecView, harmonics: number, voices = 8): Float32Array {
  const H = Math.max(HARMONICS_RANGE.min, Math.min(HARMONICS_RANGE.max, Math.round(harmonics)));
  if (view === 'audio' || H < 2) return toDb(s.data, peak(s.data));
  if (view === 'notes') return picked(s, H, Math.max(1, Math.min(8, Math.round(voices))));
  return view === 'fundamental' ? fundamentals(s, H) : peeled(s, H);
}

// The fundamentals: each bin scored by its partials together, a weighted mean of their levels in dB
// (the harmonic product spectrum, on a log axis), each partial read from the loudest of the three bins
// around where it should be, so a stretched or slightly sharp one still counts. That alone lights a
// note's second partial too, since its own partials are the note's even ones; so a bin that is a
// partial of a lower bin scoring as well or better is pushed down by six times the difference (a
// second partial at 1/2 scores about 3.5 dB under its fundamental, and lands 25 dB under it). An
// octave doubling goes with it, which is the price of reading the fundamentals off a picture.
function fundamentals(s: PitchSpectrogram, H: number): Float32Array {
  const { frames, bins } = s, db = toDb(s.data, peak(s.data)), S = new Float32Array(frames * bins), out = new Float32Array(frames * bins);
  const off = Array.from({ length: H }, (_, i) => partialOffset(i + 1)), w = off.map((_, i) => 1 / (i + 1));
  for (let n = 0; n < frames; n++) {
    const row = n * bins;
    for (let j = 0; j < bins; j++) {
      let sum = w[0] * db[row + j], wsum = w[0];
      for (let h = 1; h < H; h++) {
        const k = j + off[h];
        if (k >= bins) break;
        let m = db[row + k];
        if (k > 0 && db[row + k - 1] > m) m = db[row + k - 1];
        if (k + 1 < bins && db[row + k + 1] > m) m = db[row + k + 1];
        sum += w[h] * m;
        wsum += w[h];
      }
      S[row + j] = sum / wsum;
    }
    for (let j = 0; j < bins; j++) {
      const v = S[row + j];
      let over = 0;
      for (let h = 1; h < H; h++) {
        const k = j - off[h];
        if (k < 0) break;
        let m = S[row + k];
        if (k > 0 && S[row + k - 1] > m) m = S[row + k - 1];
        if (k + 1 < bins && S[row + k + 1] > m) m = S[row + k + 1];
        if (m - v > over) over = m - v;
      }
      out[row + j] = v - 6 * over;
    }
  }
  return out;
}

// The harmonics taken out: bins from the bottom up, each one's level subtracted from where its
// partials fall (falling off as 1/h, with some slack, since a partial left at a quarter of its level
// still draws a line), from the loudest of the three bins around each so a partial that straddles two
// bins is still met. Lower notes go first, so a note's partials are gone by the time the bins holding
// them are reached, and what is left up there is a note of its own.
function peeled(s: PitchSpectrogram, H: number): Float32Array {
  const { frames, bins } = s, ref = peak(s.data), Y = s.data.slice(), floor = ref * 1e-4;
  const off = Array.from({ length: H }, (_, i) => partialOffset(i + 1)), w = off.map((_, i) => 1 / (i + 1));
  for (let n = 0; n < frames; n++) {
    const row = n * bins;
    for (let j = 0; j < bins; j++) {
      const e = Y[row + j];
      if (e <= floor) continue;
      for (let h = 1; h < H; h++) {
        const k = row + j + off[h];
        if (j + off[h] >= bins) break;
        let budget = 1.4 * e * w[h];
        // From the loudest of the three first, then the others.
        for (let pass = 0; pass < 3 && budget > 0; pass++) {
          let best = k, bv = Y[k];
          if (j + off[h] > 0 && Y[k - 1] > bv) { best = k - 1; bv = Y[k - 1]; }
          if (j + off[h] + 1 < bins && Y[k + 1] > bv) { best = k + 1; bv = Y[k + 1]; }
          if (bv <= 0) break;
          const take = Math.min(bv, budget);
          Y[best] = bv - take;
          budget -= take;
        }
      }
    }
  }
  return toDb(Y, ref);
}

// The notes only: in each frame, the likeliest note is found, its partials are taken out, and the
// next is found in what is left, up to `voices` notes (Klapuri's estimate and cancel, 2006). A note is
// scored by its partials together, each weighted 1/h and read from the loudest of the three bins
// around where it should be; its fundamental must sound, so a note isn't found an octave under where
// only its partials are. Each partial is taken out up to the smoother of its level and its
// neighbours' mean, so a partial another note shares is left to that note. A note scoring under a
// thousandth of the frame's first (-60 dB) ends the search. Only the notes found are drawn, at their
// score, with the bins next to them a little under it so a note between two bins still reads.
function picked(s: PitchSpectrogram, H: number, voices: number): Float32Array {
  const { frames, bins, data } = s, out = new Float32Array(frames * bins), Y = new Float32Array(bins), sal = new Float32Array(bins);
  const off = Array.from({ length: H }, (_, i) => partialOffset(i + 1)), w = off.map((_, i) => 1 / (i + 1));
  const at = (k: number): number => {
    let m = Y[k];
    if (k > 0 && Y[k - 1] > m) m = Y[k - 1];
    if (k + 1 < bins && Y[k + 1] > m) m = Y[k + 1];
    return m;
  };
  const lvl = new Float32Array(H);
  for (let n = 0; n < frames; n++) {
    const row = n * bins;
    let top = 0;
    for (let j = 0; j < bins; j++) { Y[j] = data[row + j]; if (Y[j] > top) top = Y[j]; }
    if (top <= 0) continue;
    let first = 0;
    for (let v = 0; v < voices; v++) {
      let best = -1, bv = 0;
      for (let j = 0; j < bins; j++) {
        // The fundamental has to be there, a hundredth of the loudest at least (-40 dB).
        if (at(j) < 0.01 * top) { sal[j] = 0; continue; }
        let sum = 0;
        for (let h = 0; h < H; h++) { const k = j + off[h]; if (k >= bins) break; sum += w[h] * at(k); }
        sal[j] = sum;
        if (sum > bv) { bv = sum; best = j; }
      }
      if (best < 0 || (v > 0 && bv < 0.001 * first)) break;
      if (v === 0) first = bv;
      out[row + best] = Math.max(out[row + best], bv);
      if (best > 0) out[row + best - 1] = Math.max(out[row + best - 1], 0.5 * sal[best - 1]);
      if (best + 1 < bins) out[row + best + 1] = Math.max(out[row + best + 1], 0.5 * sal[best + 1]);
      for (let h = 0; h < H; h++) { const k = best + off[h]; lvl[h] = k < bins ? at(k) : 0; }
      for (let h = 0; h < H; h++) {
        const k = best + off[h];
        if (k >= bins) break;
        const nb = (lvl[Math.max(0, h - 1)] + lvl[h] + lvl[Math.min(H - 1, h + 1)]) / 3;
        // The fundamental goes whole, so the same note isn't found twice.
        let budget = h === 0 ? Infinity : Math.min(lvl[h], nb);
        for (let q = -1; q <= 1 && budget > 0; q++) {
          const b = k + q;
          if (b < 0 || b >= bins) continue;
          const take = Math.min(Y[b], budget);
          Y[b] -= take;
          if (h > 0) budget -= take;
        }
      }
    }
  }
  return toDb(out, peak(out));
}

/** The loudest the spectrogram gets at a pitch (its three bins) between times a and b, as a magnitude. */
export function levelAt(s: PitchSpectrogram, pitch: number, a: number, b: number): number {
  const j0 = (Math.round(pitch) - s.lo) * s.perSemitone;
  if (j0 < 0 || j0 + s.perSemitone > s.bins) return 0;
  const n0 = Math.max(0, Math.floor(a * s.fr)), n1 = Math.min(s.frames - 1, Math.ceil(b * s.fr));
  let m = 0;
  for (let n = n0; n <= n1; n++) {
    const row = n * s.bins + j0;
    for (let j = 0; j < s.perSemitone; j++) if (s.data[row + j] > m) m = s.data[row + j];
  }
  return m;
}
