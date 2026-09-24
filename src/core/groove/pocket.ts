// Where each drum voice sits against the beat. Every hit is put on its nearest grid step of the tempo
// map and measured from it. A tempo map found from the transients themselves is pinned to whatever
// hits the beat first, so measuring against it alone is circular: pin the map to the snare and the
// snare is "on the beat" by definition. So offsets are taken against a reference instead, the way a
// listener hears a pocket: by default the hats, the timekeeper, and bar by bar so that a drummer's
// drift doesn't read as lean. The grid itself can still be the reference, for a track played to a click.
import type { DrumHit, PerVoice, Voice } from '../drums/voices';
import { VOICES } from '../drums/voices';
import { type Meter, barQ, beatQ } from '../tempo/meter';
import type { TempoMap } from '../tempo/tempo-map';
import type { TimeRange } from '../types';

export const GROOVE_GRIDS = ['8', '16', '8t', '16t'] as const;
export type GrooveGrid = (typeof GROOVE_GRIDS)[number];
export const GROOVE_GRID_Q: Record<GrooveGrid, number> = { '8': 0.5, '16': 0.25, '8t': 1 / 3, '16t': 1 / 6 };

/** What offsets are measured against: the tempo map's grid, the whole kit, or one voice. */
export type Reference = 'grid' | 'kit' | Voice;
export const REFERENCES: readonly (Reference | 'auto')[] = ['auto', 'hat', 'kick', 'snare', 'kit', 'grid'];

export const PPQ = 480;

export interface PlacedHit {
  readonly voice: Voice;
  readonly t: number;
  /** MIDI velocity, from the hit's loudness against the voice's loud hits. */
  readonly vel: number;
  /** Bar (0 = bar 1) and grid step within it. */
  readonly bar: number;
  readonly step: number;
  /** Offset from the grid step, ms, positive late. */
  readonly gridMs: number;
  /** Offset against the reference, ms, positive late. The pocket. */
  readonly ms: number;
  /** The same in ticks at 480 per quarter note, and as a share of one grid step. */
  readonly ticks: number;
  readonly frac: number;
}

export interface VoiceStats {
  readonly voice: Voice;
  readonly n: number;
  /** Offsets against the reference, ms. */
  readonly median: number;
  readonly mean: number;
  readonly sd: number;
  readonly p25: number;
  readonly p75: number;
  /** Median offset in ticks. */
  readonly ticks: number;
  /** Where the off-beat subdivisions fall between their neighbours, percent (50 = straight), or null. */
  readonly swing: number | null;
}

export interface StepStats {
  readonly voice: Voice;
  readonly step: number;
  readonly n: number;
  /** Share of the analysed bars that have this hit. */
  readonly presence: number;
  /** Medians over the bars: one stray hit doesn't move them. */
  readonly vel: number;
  readonly ms: number;
  readonly sd: number;
  readonly ticks: number;
  readonly frac: number;
}

export interface Groove {
  readonly grid: GrooveGrid;
  readonly stepsPerBar: number;
  /** Steps per beat, for drawing beat lines. */
  readonly stepsPerBeat: number;
  /** Bars with at least one hit. */
  readonly bars: number;
  readonly ref: Reference;
  readonly bpm: number;
  readonly hits: readonly PlacedHit[];
  readonly voices: readonly VoiceStats[];
  readonly steps: readonly StepStats[];
}

export interface GrooveOptions {
  map: TempoMap;
  meter: Meter;
  grid: GrooveGrid;
  ref: Reference | 'auto';
  /** Only hits whose grid step is inside this range count, so a kick pushed ahead of the loop's first
   * downbeat still belongs to the loop. In `map`'s time. */
  range?: TimeRange;
  /**
   * When each hit is heard on `map`'s timeline, if not at its own time: the warp moves the audio onto
   * a straight grid, so its hits are measured where it puts them. Each hit keeps its own time.
   */
  at?: (t: number) => number;
}

const quantile = (s: readonly number[], p: number): number => {
  if (!s.length) return NaN;
  const i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
};
const sortNum = (a: readonly number[]) => [...a].sort((x, y) => x - y);
const mean = (a: readonly number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
const sdev = (a: readonly number[]) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / (a.length - 1));
};

/**
 * Velocities from loudness: the voice's loud hits (its 90th percentile) come out at 112, and every
 * 10 dB below takes 35 off, so a ghost note 16 dB down lands in the 50s, as a drummer would write it.
 */
export function velocities(hits: readonly DrumHit[]): number[] {
  const ref = quantile(sortNum(hits.map((h) => h.a)), 0.9) || 1;
  return hits.map((h) => Math.max(1, Math.min(127, Math.round(112 + 70 * Math.log10(Math.max(1e-6, h.a) / ref)))));
}

/** A hit as a note to hear or draw. */
export interface VoiceNote {
  readonly voice: Voice;
  readonly t: number;
  readonly vel: number;
}

/**
 * Every hit of every voice as a note, sorted by time: the drums as the MIDI export writes them, but
 * for the whole take and with no tempo map needed, so they can be heard before the beats are mapped.
 * The velocities are the pocket's, taken over each voice's hits.
 */
export function transcribe(hits: PerVoice<readonly DrumHit[]>): VoiceNote[] {
  const out: VoiceNote[] = [];
  for (const v of VOICES) {
    const vel = velocities(hits[v]);
    hits[v].forEach((h, i) => out.push({ voice: v, t: h.t, vel: vel[i] }));
  }
  return out.sort((a, b) => a.t - b.t);
}

/** The reference `auto` stands for: the hats when they keep time through the take, else the grid. */
export function autoReference(hits: readonly PlacedHit[], every: number, bars: number): Reference {
  const n = hits.filter((h) => h.voice === 'hat' && h.step % every === 0).length;
  return n >= 2 * bars ? 'hat' : 'grid';
}

export function analyseGroove(input: PerVoice<readonly DrumHit[]>, o: GrooveOptions): Groove {
  const { map, meter, grid } = o, sq = GROOVE_GRID_Q[grid], bq = barQ(meter), btq = beatQ(meter);
  const stepsPerBar = Math.max(1, Math.round(bq / sq)), stepsPerBeat = Math.max(1, Math.round(btq / sq));
  const inRange = (t: number) => !o.range || (t >= o.range.a - 0.002 && t < o.range.b - 0.002);
  const placed: Omit<PlacedHit, 'ms' | 'ticks' | 'frac'>[] = [], spq: number[] = [];
  if (!map.isEmpty) {
    for (const v of VOICES) {
      const hs = input[v], vel = velocities(hs);
      hs.forEach((h, i) => {
        const th = o.at ? o.at(h.t) : h.t, q = map.timeToPos(th);
        let bar = Math.floor(q / bq), step = Math.round((q - bar * bq) / sq);
        if (step >= stepsPerBar) { bar++; step = 0; }
        if (bar < 0) return;
        const gq = bar * bq + step * sq, gt = map.posToTime(gq);
        if (!inRange(gt)) return;
        placed.push({ voice: v, t: h.t, vel: vel[i], bar, step, gridMs: (th - gt) * 1000 });
        spq.push(map.posToTime(gq + 0.01) - gt);
      });
    }
  }
  const barsSeen = new Set(placed.map((h) => h.bar)), bars = barsSeen.size;
  // The reference's own position in each bar: the median offset of its hits on the eighths (on the
  // beats, on a triplet grid). Not the sixteenths between them, which may swing: swing isn't lean. The
  // off-beat eighths count because the hats on the beat are often buried under the kick and snare.
  const every = grid === '16' ? 2 : grid === '8' ? 1 : stepsPerBeat;
  const ref = o.ref === 'auto' ? autoReference(placed as PlacedHit[], every, bars) : o.ref;
  const refMs = new Map<number, number[]>();
  if (ref !== 'grid') {
    for (const h of placed) {
      if ((ref !== 'kit' && h.voice !== ref) || h.step % every) continue;
      const l = refMs.get(h.bar);
      if (l) l.push(h.gridMs); else refMs.set(h.bar, [h.gridMs]);
    }
  }
  const all = sortNum([...refMs.values()].flat()), overall = all.length ? quantile(all, 0.5) : 0;
  // A bar without the reference borrows its neighbours', then the whole take's.
  const shiftOf = (bar: number): number => {
    if (ref === 'grid') return 0;
    const own = refMs.get(bar);
    if (own) return quantile(sortNum(own), 0.5);
    const near = [...(refMs.get(bar - 1) ?? []), ...(refMs.get(bar + 1) ?? [])];
    return near.length ? quantile(sortNum(near), 0.5) : overall;
  };
  const hits: PlacedHit[] = placed.map((h, i) => {
    const ms = h.gridMs - shiftOf(h.bar), ticks = ((ms / 1000) * 0.01 * PPQ) / spq[i];
    return { ...h, ms, ticks, frac: ticks / (sq * PPQ) };
  });
  hits.sort((a, b) => a.t - b.t);

  const voices: VoiceStats[] = [], steps: StepStats[] = [];
  for (const v of VOICES) {
    const hv = hits.filter((h) => h.voice === v);
    if (!hv.length) continue;
    const ms = sortNum(hv.map((h) => h.ms)), tk = sortNum(hv.map((h) => h.ticks));
    voices.push({ voice: v, n: hv.length, median: quantile(ms, 0.5), mean: mean(ms), sd: sdev(ms), p25: quantile(ms, 0.25), p75: quantile(ms, 0.75), ticks: quantile(tk, 0.5), swing: swingOf(hv, grid) });
    for (let s = 0; s < stepsPerBar; s++) {
      const hs = hv.filter((h) => h.step === s);
      if (!hs.length) continue;
      const m = hs.map((h) => h.ms);
      steps.push({
        voice: v, step: s, n: hs.length, presence: hs.length / Math.max(1, bars), vel: Math.round(quantile(sortNum(hs.map((h) => h.vel)), 0.5)),
        ms: quantile(sortNum(m), 0.5), sd: sdev(m), ticks: quantile(sortNum(hs.map((h) => h.ticks)), 0.5), frac: quantile(sortNum(hs.map((h) => h.frac)), 0.5),
      });
    }
  }
  const bpm = spq.length ? 60 / (quantile(sortNum(spq), 0.5) / 0.01) : map.baseBpm;
  return { grid, stepsPerBar, stepsPerBeat, bars, ref, bpm, hits, voices, steps };
}

// Swing on a straight grid: an odd step sits between the even steps either side of it. With both at
// their median offsets, its place in that pair of steps, as a percentage, is the MPC-style swing amount.
function swingOf(hv: readonly PlacedHit[], grid: GrooveGrid): number | null {
  if (grid === '8t' || grid === '16t') return null;
  const odd = hv.filter((h) => h.step % 2 === 1).map((h) => h.frac), even = hv.filter((h) => h.step % 2 === 0).map((h) => h.frac);
  if (odd.length < 3 || even.length < 3) return null;
  return 50 * (1 + quantile(sortNum(odd), 0.5) - quantile(sortNum(even), 0.5));
}

/** One line for people: each voice's lean against the reference, and the hats' swing. */
export function describeGroove(g: Groove): string {
  if (!g.voices.length) return '';
  const refName = g.ref === 'grid' ? 'the grid' : g.ref === 'kit' ? 'the kit' : g.ref === 'hat' ? 'the hats' : 'the ' + g.ref;
  const lean = (ms: number) => (Math.abs(ms) < 1.5 ? 'on it' : ms > 0 ? `+${ms.toFixed(0)} ms behind` : `${ms.toFixed(0)} ms ahead`);
  const parts = g.voices.filter((v) => v.voice !== g.ref).map((v) => `${v.voice === 'hat' ? 'hats' : v.voice} ${lean(v.median)}`);
  const sw = g.voices.find((v) => v.voice === 'hat')?.swing ?? g.voices.find((v) => v.swing != null)?.swing;
  const swing = sw != null && Math.abs(sw - 50) >= 2 ? `, swing ${Math.round(sw)}%` : '';
  return parts.length ? `Against ${refName}: ${parts.join(', ')}${swing}` : '';
}
