// Synthetic pitched parts with known notes, for the note detector's tests and the e2e walk: a plucked
// bass line and a keyboard part in chords. Each note is synthesised from its partials, so where it
// starts, how high it is and where it ends are known exactly.

/** One note as it was played. `pitch` is a MIDI note number; `end` is where the player let it go. */
export interface PlayedNote {
  pitch: number;
  t: number;
  end: number;
  vel: number;
}

export interface PitchedPart {
  x: Float32Array;
  notes: PlayedNote[];
  /** The true beat times, bar 1 first. */
  beats: number[];
  dur: number;
  /** How far the whole part is tuned from A440, in cents. */
  tuning: number;
}

const hz = (pitch: number, cents = 0) => 440 * Math.pow(2, (pitch - 69 + cents / 100) / 12);

function beatsAt(bpm: number, n: number, lead: number): number[] {
  return Array.from({ length: n + 1 }, (_, i) => lead + (i * 60) / bpm);
}

// One note's partials, added into x: each partial rings down at its own rate (the high ones faster,
// as a string's do), and the note is damped over 12 ms where the player lets it go. `bend` is in
// cents against time into the note.
function addNote(
  x: Float32Array, sr: number, f0: number, t0: number, len: number, g: number,
  o: { partials: number; tilt: number; decay: number; inharm?: number; click?: number; bend?: (tt: number) => number; rnd: () => number },
): void {
  const s0 = Math.round(t0 * sr), damp = 0.012, n = Math.round((len + damp) * sr), B = o.inharm ?? 0;
  const ph = new Float64Array(o.partials + 1);
  for (let h = 1; h <= o.partials; h++) ph[h] = o.rnd() * 2 * Math.PI;
  for (let i = 0; i < n && s0 + i < x.length; i++) {
    const tt = i / sr, bend = o.bend ? Math.pow(2, o.bend(tt) / 1200) : 1;
    const rel = tt < len ? 1 : Math.max(0, 1 - (tt - len) / damp), att = Math.min(1, tt / 0.003);
    let v = 0;
    for (let h = 1; h <= o.partials; h++) {
      const f = f0 * bend * h * Math.sqrt(1 + B * h * h);
      if (f > sr * 0.45) break;
      ph[h] += (2 * Math.PI * f) / sr;
      v += (Math.pow(h, -o.tilt) * Math.sin(ph[h])) * Math.exp(-tt * o.decay * (1 + 0.35 * (h - 1)));
    }
    const click = o.click && tt < 0.004 ? o.click * (o.rnd() * 2 - 1) * (1 - tt / 0.004) : 0;
    if (s0 + i >= 0) x[s0 + i] += g * (v * att + click) * rel;
  }
}

/**
 * A funk bass line, two bars around again, tuned 20 cents flat: repeated notes on one pitch, an octave
 * leap, a note bent up and back, ghost-quiet notes, and notes damped short against ones left to ring.
 */
export function synthBass(sr: number, bars = 4): PitchedPart {
  let seed = 9001;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const bpm = 100, beats = beatsAt(bpm, bars * 4, 0.25), sixteenth = 15 / bpm, tuning = -20;
  // [step, pitch, length in sixteenths, velocity]
  const pattern: [number, number, number, number][] = [
    [0, 28, 3, 118], [3, 28, 1, 70], [4, 40, 2, 100], [6, 38, 1, 90], [7, 35, 1, 84],
    [8, 33, 4, 110], [12, 31, 2, 96], [14, 33, 2, 92],
    [16, 28, 2, 118], [18, 28, 1, 64], [19, 28, 1, 64], [20, 43, 3, 104], [24, 45, 6, 112], [30, 40, 2, 90],
  ];
  const dur = beats[bars * 4] + 0.8, x = new Float32Array(Math.ceil(dur * sr)), notes: PlayedNote[] = [];
  for (let rep = 0; rep * 32 < bars * 16; rep++) {
    for (const [step, pitch, len, vel] of pattern) {
      const k = rep * 32 + step;
      if (k >= bars * 16) continue;
      const t = beats[0] + k * sixteenth + (rnd() - 0.5) * 0.006, L = len * sixteenth * 0.9;
      // The long A in the second bar is bent up a whole tone and back, as a bassist pulls a string.
      const bend = step === 24 ? (tt: number) => (tt < 0.15 ? 0 : tt < 0.35 ? 200 * Math.sin(((tt - 0.15) / 0.2) * (Math.PI / 2)) : tt < 0.55 ? 200 * Math.cos(((tt - 0.35) / 0.2) * (Math.PI / 2)) : 0) : undefined;
      addNote(x, sr, hz(pitch, tuning), t, L, 0.5 * Math.pow(vel / 127, 1.6), { partials: 16, tilt: 1, decay: 2.2, click: 0.15, bend, rnd });
      notes.push({ pitch, t, end: t + L, vel });
    }
  }
  notes.sort((a, b) => a.t - b.t);
  return { x, notes, beats, dur, tuning };
}

/**
 * A keyboard part: a chord on each half bar, one of them with its root doubled an octave down, and a
 * short melody over the held last chord. Slightly stretched partials, as a piano's strings have.
 */
export function synthKeys(sr: number): PitchedPart {
  let seed = 77;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const bpm = 90, beats = beatsAt(bpm, 16, 0.3), beat = 60 / bpm;
  const chords: [number, number[]][] = [
    [0, [60, 64, 67]], [2, [57, 60, 64]], [4, [53, 57, 60, 65]], [6, [43, 55, 59, 62]],
    [8, [60, 64, 67, 72]], [10, [57, 60, 64]], [12, [53, 57, 60]],
  ];
  const dur = beats[16] + 1, x = new Float32Array(Math.ceil(dur * sr)), notes: PlayedNote[] = [];
  const play = (pitch: number, t: number, L: number, vel: number) => {
    addNote(x, sr, hz(pitch), t, L, 0.22 * Math.pow(vel / 127, 1.6), { partials: 12, tilt: 1.3, decay: 1.1, inharm: 2e-4, click: 0.03, rnd });
    notes.push({ pitch, t, end: t + L, vel });
  };
  for (const [b, ps] of chords) {
    for (const p of ps) play(p, beats[b] + rnd() * 0.004, 2 * beat * 0.92, 90 + Math.round(rnd() * 20));
  }
  // Over the last chord, held for its two beats and the two after, a melody: E, G, A, G.
  [76, 79, 81, 79].forEach((p, i) => play(p, beats[12] + i * beat * 0.5 + rnd() * 0.004, beat * 0.45, 100));
  notes.sort((a, b) => a.t - b.t || a.pitch - b.pitch);
  return { x, notes, beats, dur, tuning: 0 };
}
