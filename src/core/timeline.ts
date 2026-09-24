// The editor's timeline: where everything is drawn, and what the pointer lands on. Times here come in
// two kinds that are easy to mix up, since both are seconds:
//
//   source  a moment of the audio file: the playhead, transients, the loop, warp markers.
//   axis    a point along the editor, left to right, which the viewport turns into pixels.
//
// Musical positions (quarter notes from bar 1) are the third kind; the grid, bars and pins are drawn
// by position. The axis is always the tempo map's time, so the grid stays where the tempo map puts it.
// Where the audio is drawn on it depends on what is heard: the audio as it is, or the warp, which
// moves each moment to the position the alignment gives it. Everything drawn or read back goes through
// here, so what is drawn under the playhead is what is heard, the grid line a click falls on is the
// one drawn, and a bar or a tempo is only ever the tempo map's.
import type { Meter } from './tempo/meter';
import { barQ } from './tempo/meter';
import type { TempoMap } from './tempo/tempo-map';
import type { Alignment } from './warp/markers';

export class Timeline {
  /**
   * `map` is the music. `moved` is the alignment when the warp is heard, so the audio is drawn where
   * the warp puts it, else null. `bpm` is the steady tempo heard when the warp is, else null.
   */
  constructor(
    readonly map: TempoMap,
    private readonly moved: Alignment | null = null,
    private readonly bpm: number | null = null,
  ) {}

  /** The audio is drawn somewhere other than where it is. */
  get movesAudio(): boolean { return !!this.moved?.moved && !this.map.isEmpty; }

  /** Where on the axis the audio at source time t is drawn. */
  axisAt(t: number): number {
    return this.movesAudio ? this.map.posToTime(this.moved!.timeToPos(t)) : t;
  }

  /** The source time of the audio drawn at axis time a. */
  sourceAt(a: number): number {
    return this.movesAudio ? this.moved!.posToTime(this.map.timeToPos(a)) : a;
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

  /** The tempo heard at source time t: the warp's grid when it is heard, else the tempo map's. */
  bpmAt(t: number): number { return this.bpm ?? this.map.bpmAt(this.axisAt(t)); }

  /** The bar heard around source time t, as source times, clipped to the audio; null before bar 1. */
  barRangeAt(t: number, meter: Meter, dur: number): { bar: number; a: number; b: number } | null {
    if (this.map.isEmpty) return null;
    const q = this.posOf(t);
    if (!(q >= 0)) return null;
    const bq = barQ(meter), bar = Math.floor(q / bq + 1e-9);
    return { bar, a: this.sourceOfPos(bar * bq), b: Math.min(dur, this.sourceOfPos((bar + 1) * bq)) };
  }
}
