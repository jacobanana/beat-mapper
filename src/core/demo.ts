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
