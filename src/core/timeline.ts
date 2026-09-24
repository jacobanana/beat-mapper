// The editor's timeline: where everything is drawn, and what the pointer lands on. Times here come in
// two kinds that are easy to mix up, since both are seconds:
//
//   source  a moment of the audio file: the playhead, transients, the loop, warp markers.
//   axis    a point along the editor, left to right, which the viewport turns into pixels.
//
// Musical positions (quarter notes from bar 1) are the third kind; the grid, bars and pins are drawn
// by position. The axis is always the tempo map's time, so the grid stays where the tempo map puts it.
// Where the audio is drawn on it depends on what is heard: the audio as it is, or the warp, which
// moves each moment to the position the alignment gives it; in Drums mode the warp cuts instead of
// stretching, so each piece is drawn whole where its transient lands, cut short or followed by a gap
// as it is heard. Everything drawn or read back goes through
// here, so what is drawn under the playhead is what is heard, the grid line a click falls on is the
// one drawn, and a bar or a tempo is only ever the tempo map's.
import type { Meter } from './tempo/meter';
import { barQ } from './tempo/meter';
import type { TempoMap } from './tempo/tempo-map';
import type { TimeRange } from './types';
import type { Cuts } from './warp/beats';
import type { Alignment } from './warp/markers';

/** Drums mode's pieces, on an output timeline that starts at quarter note `q0` at the warp's tempo. */
export interface CutView {
  cuts: Cuts;
  q0: number;
  /** Output seconds of the warp. */
  outDur: number;
}

export class Timeline {
  /**
   * `map` is the music. `moved` is the alignment when the warp is heard, so the audio is drawn where
   * the warp puts it, else null. `bpm` is the steady tempo heard when the warp is, else null, and
   * `warped` the part of the audio it covers (all of it, or a loop warped on its own). `cut` is Drums
   * mode's pieces when the warp heard cuts rather than stretches: inside the warp they place the audio,
   * and the alignment only outside it.
   */
  constructor(
    readonly map: TempoMap,
    private readonly moved: Alignment | null = null,
    private readonly bpm: number | null = null,
    private readonly warped: TimeRange | null = null,
    private readonly cut: CutView | null = null,
  ) {}

  /** The audio is drawn somewhere other than where it is. */
  get movesAudio(): boolean { return (!!this.moved?.moved || this.cuts) && !this.map.isEmpty; }

  private get cuts(): boolean { return !!this.cut?.cuts.pieces.length && !!this.moved && this.bpm != null; }
  // The warp's output time, and back, for the cuts: a straight grid from q0 at the warp's tempo.
  private outOf(q: number): number { return ((q - this.cut!.q0) * 60) / this.bpm!; }
  private posOfOut(d: number): number { return this.cut!.q0 + (d * this.bpm!) / 60; }
  private inCuts(t: number): boolean { return this.cuts && t >= this.cut!.cuts.a && t <= this.cut!.cuts.b; }

  /** Where on the axis the audio at source time t is drawn. */
  axisAt(t: number): number {
    if (!this.movesAudio) return t;
    if (this.inCuts(t)) return this.map.posToTime(this.posOfOut(this.cut!.cuts.dstAt(t)));
    return this.map.posToTime(this.moved!.timeToPos(t));
  }

  /** The source time of the audio drawn at axis time a; in a gap, the end of what was heard before it. */
  sourceAt(a: number): number {
    if (!this.movesAudio) return a;
    const q = this.map.timeToPos(a);
    if (this.cuts) {
      const d = this.outOf(q);
      if (d >= this.cut!.cuts.start && d <= this.cut!.outDur) return this.cut!.cuts.srcAt(d);
    }
    return this.moved!.posToTime(q);
  }

  /**
   * The stretches of audio drawn between axis times a0 and a1, as source `[from, to]` pairs in order:
   * one unbroken stretch, unless Drums mode cuts it into pieces with gaps and cut-off tails between.
   */
  heard(a0: number, a1: number): [number, number][] {
    if (!this.cuts || !this.movesAudio) return [[this.sourceAt(a0), this.sourceAt(a1)]];
    const { cuts, outDur } = this.cut!, s = cuts.start, d0 = this.outOf(this.map.timeToPos(a0)), d1 = this.outOf(this.map.timeToPos(a1));
    const out: [number, number][] = [];
    // Before and after the warp the audio is where the alignment has it, as it is not heard warped.
    if (d0 < s) out.push([this.sourceAt(a0), this.moved!.posToTime(this.posOfOut(Math.min(s, d1)))]);
    if (d1 > s && d0 < outDur) out.push(...cuts.heard(Math.max(s, d0), Math.min(outDur, d1)));
    if (d1 > outDur) out.push([this.moved!.posToTime(this.posOfOut(Math.max(outDur, d0))), this.sourceAt(a1)]);
    return out.filter(([a, b]) => b > a);
  }

  /** Drums mode's gaps between axis times a0 and a1: axis ranges a..b, and `len`, seconds heard. */
  gaps(a0: number, a1: number): { a: number; b: number; len: number }[] {
    if (!this.cuts || !this.movesAudio) return [];
    const at = (d: number) => this.map.posToTime(this.posOfOut(d));
    return this.cut!.cuts.gaps(this.outOf(this.map.timeToPos(a0)), this.outOf(this.map.timeToPos(a1))).map(([a, b]) => ({ a: at(a), b: at(b), len: b - a }));
  }

  /** Where on the axis position q is: its grid line. */
  axisOfPos(q: number): number { return this.map.posToTime(q); }

  /** The position at axis time a. */
  posAtAxis(a: number): number { return this.map.timeToPos(a); }

  /** The position the audio at source time t is heard at, against the grid drawn. */
  posOf(t: number): number { return this.map.timeToPos(this.axisAt(t)); }

  /** The source time heard at position q: the audio drawn on that line. */
  sourceOfPos(q: number): number { return this.sourceAt(this.axisOfPos(q)); }

  /** Bar and beat (0-based) the audio at source time t is heard on, or null in the lead-in. */
  barBeatAt(t: number, meter: Meter): { bar: number; beat: number } | null {
    return this.map.barBeatAt(this.axisAt(t), meter);
  }

  /** The tempo heard at source time t: the warp's grid where it is heard, else the tempo map's. */
  bpmAt(t: number): number {
    const w = this.warped;
    return this.bpm != null && (!w || (t >= w.a && t <= w.b)) ? this.bpm : this.map.bpmAt(this.axisAt(t));
  }

  /** The bar heard around source time t, as source times, clipped to the audio; null before bar 1. */
  barRangeAt(t: number, meter: Meter, dur: number): { bar: number; a: number; b: number } | null {
    if (this.map.isEmpty) return null;
    const q = this.posOf(t);
    if (!(q >= 0)) return null;
    const bq = barQ(meter), bar = Math.floor(q / bq + 1e-9);
    return { bar, a: this.sourceOfPos(bar * bq), b: Math.min(dur, this.sourceOfPos((bar + 1) * bq)) };
  }
}
