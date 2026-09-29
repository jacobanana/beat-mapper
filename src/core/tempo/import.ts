// A tempo map from elsewhere (a DAW's MIDI file) laid onto the audio as pins. The file's start is a
// moment of the audio, usually its very start, since a DAW bounces the audio and the tempo map from
// the same point of the song.
import type { Anchor } from '../types';
import { type Meter, DENOMINATORS, barQ, beatQ } from './meter';

/** A tempo map as a MIDI file holds it: positions are quarter notes from the file's start. */
export interface MidiTempo {
  /** Tempo changes, sorted by q. */
  readonly tempos: readonly { q: number; bpm: number }[];
  /** Time signatures, sorted by q. */
  readonly sigs: readonly { q: number; num: number; den: number }[];
}

export interface ImportedTempo {
  anchors: Anchor[];
  baseBpm: number;
  meter: Meter;
  /** Tempo changes that fall within the audio, counting the one bar 1 starts at. */
  changes: number;
  minBpm: number;
  maxBpm: number;
  /** Bar 1 in the audio, seconds. */
  bar1: number;
  /** Quarter notes before bar 1: a pickup bar in the file, left out of the bars. */
  pickupQ: number;
  /** The first bar (1-based) where the file changes its time signature; BeatMapper keeps one meter. */
  meterChangeBar: number | null;
  /** The file's time signature at bar 1 isn't one BeatMapper can use, so the meter is 4/4. */
  meterKept: boolean;
}

/** Tempo changes closer than this (quarter notes) are thinned: a ramp written a tick apart. */
const MIN_STEP_Q = 0.25;
const DEFAULT_BPM = 120;

/**
 * Pins for the tempo map in `src`, its start at `start` seconds into audio `dur` seconds long. The map
 * is straight between pins, so a pin on every tempo change gives back the file's steps exactly, and a
 * ramp written as a change every few ticks is kept a sixteenth apart, each pin on the file's curve.
 * One tempo throughout is bar 1 and the starting tempo, as a map begun by hand would be. A file that
 * opens with a single bar in another time signature (a pickup, or the lead-in BeatMapper writes before
 * bar 1) has its bar 1 after it. Returns null when bar 1 falls after the end of the audio.
 */
export function importTempo(src: MidiTempo, dur: number, start = 0): ImportedTempo | null {
  // A file with no tempo is at 120, and one whose first change comes late is at 120 until it.
  const T = src.tempos.filter((x) => x.q >= 0 && x.bpm > 0 && Number.isFinite(x.bpm));
  if (!T.length || T[0].q > 1e-9) T.unshift({ q: 0, bpm: DEFAULT_BPM });
  const tempos: { q: number; bpm: number; t: number }[] = [];
  for (const x of T) {
    const last = tempos[tempos.length - 1];
    if (last && x.q - last.q < 1e-9) { last.bpm = x.bpm; continue; }
    const t = last ? last.t + ((x.q - last.q) * 60) / last.bpm : 0;
    tempos.push({ q: x.q, bpm: x.bpm, t });
  }
  const segAt = (q: number) => {
    let i = 0;
    while (i + 1 < tempos.length && tempos[i + 1].q <= q + 1e-9) i++;
    return tempos[i];
  };
  const timeOf = (q: number) => { const s = segAt(q); return start + s.t + ((q - s.q) * 60) / s.bpm; };

  const S = src.sigs.filter((s) => s.q >= 0);
  if (!S.length || S[0].q > 1e-9) S.unshift({ q: 0, num: 4, den: 4 });
  const same = (a: { num: number; den: number }, b: { num: number; den: number }) => a.num === b.num && a.den === b.den;
  const pickup = S.length > 1 && !same(S[0], S[1]) && Math.abs(S[1].q - S[0].q - barQ(S[0])) < 1e-6;
  const q1 = pickup ? S[1].q : 0, sig = pickup ? S[1] : [...S].reverse().find((s) => s.q <= 1e-9) ?? S[0];
  const usable = (DENOMINATORS as readonly number[]).includes(sig.den) && sig.num >= 1 && sig.num <= 32;
  const meter: Meter = usable ? { num: sig.num, den: sig.den } : { num: 4, den: 4 };
  const bq = barQ(meter);
  const change = S.find((s) => s.q > q1 + 1e-9 && !same(s, meter));
  const meterChangeBar = change ? Math.floor((change.q - q1) / bq + 1e-9) + 1 : null;

  const bar1 = timeOf(q1);
  if (!(bar1 < dur)) return null;
  const at = (q: number): Anchor => ({ q: q - q1, t: timeOf(q), manual: true });
  const anchors: Anchor[] = [at(q1)];
  let lastQ = q1;
  const inAudio = tempos.filter((x) => x.q > q1 + 1e-9 && timeOf(x.q) < dur);
  for (const x of inAudio) {
    if (x.q - lastQ < MIN_STEP_Q - 1e-9) continue;
    anchors.push(at(x.q));
    lastQ = x.q;
  }
  const first = segAt(q1).bpm, bpms = [first, ...inAudio.map((x) => x.bpm)];
  if (inAudio.length) {
    // After the last pin the map carries on at the tempo between the last two, so one more pin, at
    // the same tempo as the last, holds the file's closing tempo to the end: on the last beat inside
    // the audio if there is room, else a beat on (or at the next change, if that comes sooner).
    const btq = beatQ(meter), endQ = q1 + Math.floor((qAtTime(tempos, dur - start) - q1) / btq + 1e-9) * btq;
    const next = tempos.find((x) => x.q > lastQ + 1e-9)?.q ?? Infinity;
    const closeQ = endQ > lastQ + MIN_STEP_Q - 1e-9 && timeOf(endQ) < dur ? endQ : Math.min(next, lastQ + btq);
    anchors.push(at(closeQ));
  }
  return {
    anchors,
    baseBpm: first,
    meter,
    changes: bpms.length,
    minBpm: Math.min(...bpms),
    maxBpm: Math.max(...bpms),
    bar1,
    pickupQ: q1,
    meterChangeBar,
    meterKept: !usable,
  };
}

/** The file's position (quarter notes) at `t` seconds from its start. */
function qAtTime(tempos: readonly { q: number; bpm: number; t: number }[], t: number): number {
  let i = 0;
  while (i + 1 < tempos.length && tempos[i + 1].t <= t) i++;
  const s = tempos[i];
  return s.q + ((t - s.t) * s.bpm) / 60;
}
