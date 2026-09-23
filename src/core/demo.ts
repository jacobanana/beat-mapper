/** A synthetic drum loop whose tempo drifts, with the true beat and onset times it was built from. */
export interface DemoLoop {
  x: Float32Array;
  beats: number[];
  onsets: number[];
  dur: number;
}

export function synthDemo(sr: number): DemoLoop {
  let seed = 12345;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const bars = 16, beats: number[] = [], lead = 0.372;
  let t = lead;
  for (let i = 0; i <= bars * 4; i++) {
    beats.push(t);
    const ph = i / (bars * 4), bpm = 94 + 7 * ph + 2.2 * Math.sin(ph * 9);
    t += 60 / bpm;
  }
  const dur = beats[bars * 4] + 0.6, x = new Float32Array(Math.ceil(dur * sr)), onsets: number[] = [];
  const put = (t0: number, len: number, fn: (tt: number, i: number) => number) => {
    const s = Math.round(t0 * sr), n = Math.round(len * sr);
    for (let i = 0; i < n && s + i < x.length; i++) x[s + i] += fn(i / sr, i);
  };
  for (let i = 0; i < bars * 4; i++) {
    const b = beats[i], nb = beats[i + 1], pos = i % 4;
    if (pos === 0 || pos === 2) {
      // kick
      onsets.push(b);
      let ph = 0;
      put(b, 0.28, (tt) => {
        const f = 48 + 95 * Math.exp(-tt / 0.035);
        ph += (2 * Math.PI * f) / sr;
        return 0.85 * Math.sin(ph) * Math.exp(-tt / 0.11) * Math.min(1, tt / 0.0015);
      });
    } else {
      // snare
      onsets.push(b);
      put(b, 0.2, (tt) => (0.5 * (rnd() * 2 - 1) * Math.exp(-tt / 0.05) + 0.35 * Math.sin(2 * Math.PI * 190 * tt) * Math.exp(-tt / 0.04)) * Math.min(1, tt / 0.001));
    }
    // two hats per beat, the off-beat one a little loose
    for (let h = 0; h < 2; h++) {
      const ht = b + ((nb - b) * h) / 2 + (h ? (rnd() - 0.5) * 0.008 : 0);
      if (h) onsets.push(ht);
      let pv = 0;
      put(ht, 0.06, (tt) => { const r = rnd() * 2 - 1, o = r - pv; pv = r; return 0.16 * o * Math.exp(-tt / 0.015); });
    }
  }
  onsets.sort((a, b) => a - b);
  return { x, beats, onsets, dur };
}

/** One hit of the pocket demo, as it was played. */
export interface KitHit {
  voice: 'kick' | 'snare' | 'hat';
  t: number;
  vel: number;
  /** Bar (0-based) and sixteenth within it. */
  bar: number;
  step: number;
  /** How far it was played off the grid, ms. Positive is late. */
  offMs: number;
}

export interface KitLoop {
  x: Float32Array;
  /** The true beat times, bar 1 first (one more than the bars hold, to close the last). */
  beats: number[];
  hits: KitHit[];
  dur: number;
}

// The pocket every voice of the demo sits in, ms: the kick pushes, the backbeat lays back, the hats
// keep time. Ghost snares sit a little late too.
export const KIT_POCKET = { kick: -6, snare: 16, ghost: 6, hat: 0 };

/**
 * A four-bar-and-over funk groove on a synthesised kit, with a known pocket: every voice played off
 * the grid by its own amount, plus a little human scatter. The tempo breathes a bit, as a player's does.
 */
export function synthKit(sr: number, bars = 8): KitLoop {
  let seed = 424242;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const beats: number[] = [];
  let t = 0.3;
  for (let i = 0; i <= bars * 4; i++) {
    beats.push(t);
    const ph = i / (bars * 4);
    t += 60 / (92 + 3 * Math.sin(ph * Math.PI * 2));
  }
  const dur = beats[bars * 4] + 0.8, x = new Float32Array(Math.ceil(dur * sr)), hits: KitHit[] = [];
  const put = (t0: number, len: number, fn: (tt: number) => number) => {
    const s = Math.round(t0 * sr), n = Math.round(len * sr);
    for (let i = 0; i < n && s + i < x.length; i++) if (s + i >= 0) x[s + i] += fn(i / sr);
  };
  const sound = {
    kick: (t0: number, g: number) => {
      let ph = 0;
      put(t0, 0.35, (tt) => {
        const f = 52 + 110 * Math.exp(-tt / 0.03);
        ph += (2 * Math.PI * f) / sr;
        const click = tt < 0.004 ? (rnd() * 2 - 1) * 0.25 * (1 - tt / 0.004) : 0;
        return g * (0.9 * Math.sin(ph) * Math.exp(-tt / 0.16) + click) * Math.min(1, tt / 0.001);
      });
    },
    snare: (t0: number, g: number) => {
      let p1 = 0, n1 = 0;
      put(t0, 0.25, (tt) => {
        const r = rnd() * 2 - 1, hp = r - n1; n1 = r;
        p1 += (2 * Math.PI * 185) / sr;
        return g * (0.45 * Math.sin(p1) * Math.exp(-tt / 0.05) + 0.5 * (0.6 * hp + 0.4 * r) * Math.exp(-tt / 0.07)) * Math.min(1, tt / 0.0008);
      });
    },
    hat: (t0: number, g: number) => {
      let a = 0, b = 0;
      put(t0, 0.08, (tt) => {
        const r = rnd() * 2 - 1, d1 = r - a; a = r;
        const d2 = d1 - b; b = d1;
        return g * 0.3 * d2 * Math.exp(-tt / 0.022);
      });
    },
  };
  // step → [voice, velocity, pocket]
  const pattern: [number, KitHit['voice'], number, number][] = [
    [0, 'kick', 118, KIT_POCKET.kick], [7, 'kick', 92, KIT_POCKET.kick], [10, 'kick', 108, KIT_POCKET.kick],
    [4, 'snare', 122, KIT_POCKET.snare], [12, 'snare', 122, KIT_POCKET.snare],
    [9, 'snare', 42, KIT_POCKET.ghost], [15, 'snare', 38, KIT_POCKET.ghost],
  ];
  for (let s = 0; s < 16; s += 2) pattern.push([s, 'hat', s % 4 ? 72 : 100, KIT_POCKET.hat]);
  for (let bar = 0; bar < bars; bar++) {
    for (const [step, voice, vel, off] of pattern) {
      const bi = bar * 4 + (step >> 2), b = beats[bi], nb = beats[bi + 1];
      const grid = b + ((nb - b) * (step & 3)) / 4, offMs = off + (rnd() - 0.5) * 4, th = grid + offMs / 1000;
      sound[voice](th, Math.pow(vel / 127, 1.6));
      hits.push({ voice, t: th, vel, bar, step, offMs });
    }
  }
  hits.sort((a, b) => a.t - b.t);
  return { x, beats, hits, dur };
}
