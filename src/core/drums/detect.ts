// Kick, snare and hats from one recording. The spectrogram is factorised into a template and an
// activation per voice (nmf.ts); each activation's rises are the voice's hits; each hit is then placed
// at sample level on a copy of the audio filtered to that voice's range, so a hat landing on top of a
// kick is timed by its own attack and not by the kick's.
import { filtfilt, type FilterKind } from '../dsp/filter';
import { refineOnset } from '../dsp/refine';
import { nmf } from './nmf';
import { type Spectrogram, logSpectrogram } from './spectrogram';
import { type DrumHit, type PerVoice, type Voice, VOICES, perVoice } from './voices';

/** What the audio is: a drum stem or loop, or a full mix with other instruments in it. */
export type DrumSource = 'drums' | 'mix';

export interface DrumAnalysis {
  /** Every hit that could be one, per voice, sorted by time. Sensitivity picks among them later. */
  readonly hits: PerVoice<DrumHit[]>;
  /** Each voice's activation, one value per spectrogram frame, for drawing. */
  readonly activation: PerVoice<Float32Array>;
  /** The hat activation without the kick's and snare's bleed: how long each hat rings, open or closed. */
  readonly hatRing: Float32Array;
  /** Frames per second of the activations; frame n sits at n / fr seconds. */
  readonly fr: number;
  readonly source: DrumSource;
}

export interface DrumOptions {
  source?: DrumSource;
  onProgress?: (fraction: number) => void;
  yieldToEventLoop?: boolean;
}

// Where each voice's energy may sit (lo..hi, Hz) and where it mostly does: log-frequency bumps of a
// centre (Hz), a width (octaves) and a weight, per bin. The bumps are rough on purpose; the model
// adapts them to the kit it hears. The ranges are strict: multiplicative updates never bring back a
// zero, so no template can reach outside its own. A snare template allowed down to 150 Hz explains
// the upper half of every kick's pitch sweep and fires on each kick; kept above 400 Hz, it answers
// only to the wires and the crack, which a kick doesn't have.
const PRIOR: PerVoice<{ lo: number; hi: number; bumps: [number, number, number][] }> = {
  kick: { lo: 0, hi: 300, bumps: [[65, 0.8, 1]] },
  snare: { lo: 400, hi: 20000, bumps: [[2500, 1.3, 1]] },
  hat: { lo: 3000, hi: 20000, bumps: [[9000, 0.7, 1]] },
};

// The range each voice's attack is timed in. Zero-phase filters don't delay anything, but they do
// ring before an edge, and the lower the cutoff the longer: a 160 Hz lowpass put kicks 2 ms early.
// These corners keep that under 0.2 ms for every voice (measured on the synthetic kit), while still
// keeping the others out: the snare's band stops short of the hats, so a hat played on the grid just
// before a laid-back snare isn't taken for the snare's attack.
const TIMING_FILTER: PerVoice<{ kind: FilterKind; f: number }[]> = {
  kick: [{ kind: 'lowpass', f: 600 }],
  snare: [{ kind: 'highpass', f: 600 }, { kind: 'lowpass', f: 3500 }],
  hat: [{ kind: 'highpass', f: 6000 }],
};

/** Free components added for a full mix: enough for bass, a chord instrument and a voice or two. */
const MIX_FREE = 8;

/** A voice's prior on the spectrogram's bands. It is a density per bin, so a band gets it once per bin. */
export function priorTemplate(voice: Voice, sp: Pick<Spectrogram, 'freqs' | 'widths' | 'bands'>): Float32Array {
  const w = new Float32Array(sp.bands);
  const p = PRIOR[voice];
  for (let k = 0; k < sp.bands; k++) {
    const f = sp.freqs[k];
    if (f < p.lo || f > p.hi) continue;
    let d = 1e-3;
    for (const [c, oct, g] of p.bumps) { const z = Math.log2(f / c) / oct; d += g * Math.exp(-0.5 * z * z); }
    w[k] = d * sp.widths[k];
  }
  return w;
}

export async function detectDrums(x: Float32Array, sr: number, o: DrumOptions = {}): Promise<DrumAnalysis> {
  const { source = 'drums', onProgress, yieldToEventLoop = true } = o;
  const report = async (f: number) => {
    onProgress?.(f);
    if (yieldToEventLoop) await new Promise((r) => setTimeout(r, 0));
  };
  const sp = await logSpectrogram(x, sr, { percussive: source === 'mix', onProgress: (f) => onProgress?.(0.3 * f), yieldToEventLoop });
  const priors = VOICES.map((v) => priorTemplate(v, sp));
  await report(0.35);
  const { H } = nmf(sp.data, sp.frames, sp.bands, priors, { free: source === 'mix' ? MIX_FREE : 0, iterations: source === 'mix' ? 60 : 40 });
  await report(0.8);
  const F = sp.frames, activation = perVoice((v) => H.slice(VOICES.indexOf(v) * F, (VOICES.indexOf(v) + 1) * F));
  const raw = perVoice<DrumHit[]>(() => []);
  for (const v of VOICES) {
    const xv = filtfilt(x, sr, TIMING_FILTER[v]);
    raw[v] = pickHits(activation[v], sp.fr, xv, sr);
    await report(0.8 + 0.2 * ((VOICES.indexOf(v) + 1) / VOICES.length));
  }
  const ratio = leakRatios(raw, activation, sp.fr);
  return { hits: cancelLeaks(raw, activation, sp.fr, ratio), activation, hatRing: withoutLeaks('hat', activation, ratio), fr: sp.fr, source };
}

/** The loudest a voice's activation gets around time t: from 15 ms before to 25 ms after. */
function levelAt(h: Float32Array, fr: number, t: number): number {
  let m = 0;
  for (let n = Math.max(0, Math.floor((t - 0.015) * fr)), e = Math.min(h.length - 1, Math.ceil((t + 0.025) * fr)); n <= e; n++) if (h[n] > m) m = h[n];
  return m;
}

// Even with each template kept to its own range, voices bleed into each other where the ranges meet:
// a kick's beater click lights up the snare, a snare's body the kick, its wires the hats. The bleed
// is a steady fraction of the loud voice's level, so it is measured from the recording itself: at
// each hit of voice u, the level of voice v divided by u's. Most of u's hits have no v on them, so
// the low end of those ratios (the 10th percentile) is the bleed alone. Each hit then has the most
// bleed any other voice could have put there subtracted, with a margin; what is left is its own level.
const LEAK_MARGIN = 1.3;

/** How much of voice u's level shows in voice v's activation: `ratio[u][v]`, from the recording. */
export function leakRatios(raw: PerVoice<DrumHit[]>, act: PerVoice<Float32Array>, fr: number): PerVoice<PerVoice<number>> {
  const ratio = perVoice(() => perVoice(() => 0));
  for (const u of VOICES) {
    const hits = raw[u].filter((h) => h.s >= 0.1);
    for (const v of VOICES) {
      if (v === u || !hits.length) continue;
      const r = hits.map((h) => levelAt(act[v], fr, h.t) / (h.a || 1)).sort((a, b) => a - b);
      ratio[u][v] = r[Math.floor(r.length * 0.1)];
    }
  }
  return ratio;
}

export function cancelLeaks(raw: PerVoice<DrumHit[]>, act: PerVoice<Float32Array>, fr: number, ratio = leakRatios(raw, act, fr)): PerVoice<DrumHit[]> {
  return perVoice((v) => raw[v].flatMap((h) => {
    let leak = 0;
    for (const u of VOICES) if (u !== v) leak = Math.max(leak, ratio[u][v] * levelAt(act[u], fr, h.t));
    const a = h.a - LEAK_MARGIN * leak;
    return a > 0 ? [{ t: h.t, s: (h.s * a) / h.a, a }] : [];
  }));
}

// A bleed's tail need not fade at the same rate as the voice it comes from: a snare's wires ring on
// in the hat's range after its body, which leads its activation, has faded. So the margin is wider
// than for a hit's level. On the synthetic kit it takes a closed hat under the snare from ringing up
// to 96 ms to at most 75, and leaves the open hats (125 ms and more) as they were.
const RING_MARGIN = 2;

/**
 * Voice v's activation with the others' bleed taken out frame by frame, as `cancelLeaks` takes it out
 * of each hit: what is left rings only as long as v itself does. A closed hat under a snare otherwise
 * rings as long as the snare's wires.
 */
export function withoutLeaks(v: Voice, act: PerVoice<Float32Array>, ratio: PerVoice<PerVoice<number>>): Float32Array {
  const h = act[v], out = new Float32Array(h.length);
  for (let n = 0; n < h.length; n++) {
    let leak = 0;
    for (const u of VOICES) if (u !== v) leak = Math.max(leak, ratio[u][v] * act[u][n]);
    out[n] = Math.max(0, h[n] - RING_MARGIN * leak);
  }
  return out;
}

/**
 * The hits in one activation: every local maximum that rises out of what came before it. `s` is the
 * rise against the file's typical rise, `a` the peak itself (how loud). Each is timed on the rise's
 * steepest frame and then at sample level on `xv`, the audio filtered to the voice.
 */
export function pickHits(h: Float32Array, fr: number, xv: Float32Array, sr: number): DrumHit[] {
  const n = h.length, m = Math.max(1, Math.round(0.02 * fr)), L = Math.max(2, Math.round(0.05 * fr));
  const raw: { n: number; rise: number; k: number }[] = [];
  for (let i = 1; i < n - 1; i++) {
    const v = h[i];
    let ok = v > 0;
    for (let j = Math.max(0, i - m); ok && j <= Math.min(n - 1, i + m); j++) if (h[j] > v || (h[j] === v && j < i)) ok = false;
    if (!ok) continue;
    let lo = v, k = i, best = 0;
    for (let j = i; j > Math.max(0, i - L); j--) {
      if (h[j - 1] < lo) lo = h[j - 1];
      const d = h[j] - h[j - 1];
      if (d > best) { best = d; k = j; }
    }
    // A bump on a decaying tail rises by only a little of its height; a hit rises out of near silence
    // or at least doubles what was ringing. Rises of under half the peak count for proportionally less.
    if (v - lo > 0) raw.push({ n: i, rise: (v - lo) * Math.min(1, (2 * (v - lo)) / v), k });
  }
  if (!raw.length) return [];
  const sorted = raw.map((r) => r.rise).sort((a, b) => a - b);
  const ref = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.98))] || 1;
  const out: DrumHit[] = [];
  for (const r of raw) {
    const s = Math.min(1, r.rise / ref);
    if (s < 0.02) continue;
    // The steepest frame's window is centred up to half a window after the attack began.
    const tc = r.k / fr, t = refineOnset(xv, sr, tc);
    out.push({ t: Math.abs(t - tc) < 0.03 ? t : tc, s, a: h[r.n] });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}
