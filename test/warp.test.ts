import { describe, expect, it } from 'vitest';
import { synthDemo } from '../src/core/demo';
import { TempoMap } from '../src/core/tempo/tempo-map';
import { WarpMap, averageBpm, gridBeats, planWarp, warpRange } from '../src/core/warp/map';
import { heardLen, planCuts } from '../src/core/warp/beats';
import { WARP_MODES, type WarpMode, renderWarp } from '../src/core/warp/modes';

const sr = 22050;
const meter = { num: 4, den: 4 };

// A map pinned on every true beat of the drifting demo loop.
const demo = synthDemo(sr);
const demoMap = new TempoMap(demo.beats.map((t, i) => ({ q: i, t, manual: true })), 100);

const job = (chans: Float32Array[], w: WarpMap, mode: WarpMode, transients: number[] = []) =>
  renderWarp({ chans, sr, src: [...w.src], dst: [...w.dst], n: Math.round(w.outDur * sr), mode, transients });

// Where the signal first gets loud after `from`, seconds.
function onsetAfter(y: Float32Array, from: number, thr: number): number {
  for (let i = Math.max(0, Math.round(from * sr)); i < y.length; i++) if (Math.abs(y[i]) > thr) return i / sr;
  return NaN;
}

// Frequency from the rising zero crossings in the middle of the signal.
function freqOf(y: Float32Array): number {
  const a = Math.floor(y.length * 0.2), b = Math.floor(y.length * 0.8);
  let first = -1, last = -1, n = 0;
  for (let i = a + 1; i < b; i++) if (y[i - 1] < 0 && y[i] >= 0) { if (first < 0) first = i; last = i; n++; }
  return ((n - 1) * sr) / (last - first);
}
const rms = (y: Float32Array) => Math.sqrt(y.reduce((s, v) => s + v * v, 0) / y.length);

describe('the warp map', () => {
  it('puts every pin on a steady grid, and inverts', () => {
    const r = warpRange(demoMap, meter, demo.dur, { lead: 'trim', loop: null });
    expect(r.a).toBeCloseTo(demo.beats[0], 9);
    const w = planWarp(demoMap, r, 120);
    demo.beats.forEach((t, i) => expect(w.dstAt(t)).toBeCloseTo(i * 0.5, 9));
    expect(w.srcAt(w.dstAt(3.21))).toBeCloseTo(3.21, 9);
  });

  it('keeps the lead-in and starts the file on a bar line', () => {
    const r = warpRange(demoMap, meter, demo.dur, { lead: 'full', loop: null });
    expect(r.a).toBe(0);
    expect(r.q0).toBe(-4);
    const w = planWarp(demoMap, r, 120);
    expect(w.dstAt(demo.beats[0])).toBeCloseTo(2, 9);
    expect(w.srcAt(0)).toBeLessThan(0);
  });

  it('warps a loop on its own, to an exact number of beats', () => {
    const loop = { a: demo.beats[4], b: demo.beats[12] };
    const r = warpRange(demoMap, meter, demo.dur, { lead: 'full', loop });
    const w = planWarp(demoMap, r, 96);
    expect(w.outDur).toBeCloseTo((8 * 60) / 96, 9);
    expect(averageBpm(demoMap, loop)).toBeCloseTo((8 * 60) / (loop.b - loop.a), 9);
  });

  it('clicks the straight grid over the warped audio, bar 1 where the pins put it', () => {
    const r = warpRange(demoMap, meter, demo.dur, { lead: 'full', loop: null });
    const w = planWarp(demoMap, r, 120), out: [number, boolean][] = [];
    gridBeats(r.q0, 120, meter, 0, 4.01, (t, down) => out.push([t, down]));
    // The lead-in bar, then bar 1 two seconds in, where its pin went: a beat every half second.
    expect(out.map(([t]) => t)).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4]);
    expect(out.filter(([, d]) => d).map(([t]) => t)).toEqual([0, 2, 4]);
    expect(w.dstAt(demo.beats[0])).toBeCloseTo(out[4][0], 9);
    // In 6/8 a beat is an eighth note and a bar six of them.
    const eighths: number[] = [];
    gridBeats(0, 60, { num: 6, den: 8 }, 0, 3.01, (t, d) => { if (d) eighths.push(t); });
    expect(eighths).toEqual([0, 3]);
  });
});

describe('each warp mode', () => {
  // A 440 Hz tone slowed to 80 % speed: every mode but re-pitch keeps its pitch and its level.
  const tone = new Float32Array(sr * 2).map((_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / sr));
  const slow = new WarpMap([0, 2], [0, 2.5]);

  for (const mode of WARP_MODES.filter((m) => m !== 'beats')) {
    it(`${mode}: stretches a tone to length${mode === 'repitch' ? ', lowering it' : ' at the same pitch'}`, () => {
      const [y] = job([tone], slow, mode);
      expect(y.length).toBe(Math.round(2.5 * sr));
      expect(freqOf(y)).toBeCloseTo(mode === 'repitch' ? 440 * 0.8 : 440, 0);
      expect(rms(y.subarray(sr / 2, sr * 2))).toBeGreaterThan(0.3);
      expect(rms(y.subarray(sr / 2, sr * 2))).toBeLessThan(0.4);
    });
  }

  it('keeps stereo channels apart', () => {
    const quiet = tone.map((v) => v * 0.25);
    for (const mode of ['poly', 'mono', 'music'] as const) {
      const [l, r] = job([tone, quiet], slow, mode);
      expect(rms(r.subarray(sr / 2, sr * 2)) / rms(l.subarray(sr / 2, sr * 2))).toBeCloseTo(0.25, 1);
    }
  });

  // The drifting demo onto 120 BPM: every beat's hit should now start on the grid, to the sample where
  // nothing is stretched and within a frame's shift where it is.
  const r = warpRange(demoMap, meter, demo.dur, { lead: 'trim', loop: null });
  const w = planWarp(demoMap, r, 120);
  const tolMs: Record<WarpMode, number> = { beats: 1, repitch: 0.5, mono: 12, vocal: 8, poly: 12, music: 2 };
  for (const mode of WARP_MODES) {
    it(`${mode}: lands the demo's beats on a 120 BPM grid`, () => {
      const [y] = job([demo.x], w, mode, demo.onsets);
      expect(y.length).toBe(Math.round(w.outDur * sr));
      const errs: number[] = [];
      for (let i = 1; i < 60; i++) errs.push(Math.abs(onsetAfter(y, i * 0.5 - 0.04, 0.1) - i * 0.5) * 1000);
      errs.sort((a, b) => a - b);
      expect(errs[Math.floor(errs.length * 0.9)]).toBeLessThan(tolMs[mode]);
    });
  }
});

describe('Drums mode', () => {
  // The demo slowed from its own tempo to 90 BPM: every piece has room to spare, so each leaves a gap.
  const r = warpRange(demoMap, meter, demo.dur, { lead: 'trim', loop: null });
  const slow = planWarp(demoMap, r, 90), n = Math.round(slow.outDur * sr);
  const cuts = planCuts(slow, demo.onsets, demo.dur, slow.outDur);
  const render = (fill: boolean) => renderWarp({ chans: [demo.x], sr, src: [...slow.src], dst: [...slow.dst], n, mode: 'beats', transients: demo.onsets, fill })[0];
  const peak = (y: Float32Array, a: number, b: number) => { let m = 0; for (let i = Math.ceil(a * sr); i < Math.floor(b * sr); i++) m = Math.max(m, Math.abs(y[i])); return m; };

  it('lays every piece down whole, at its own speed, where it is drawn', () => {
    const y = render(false);
    for (const p of cuts.pieces.slice(1, 40)) {
      // A piece is the source played as it is, from where the warp puts its cut.
      const d0 = Math.round(p.d * sr), s0 = Math.round(p.s * sr);
      for (const j of [40, 200, 600]) if (j < heardLen(p) * sr - 100) expect(y[d0 + j]).toBeCloseTo(demo.x[s0 + j], 6);
      expect(cuts.dstAt(p.s + 0.01)).toBeCloseTo(p.d + 0.01, 9);
      expect(cuts.srcAt(p.d + 0.01)).toBeCloseTo(p.s + 0.01, 9);
    }
  });

  it('leaves the gaps silent, and says where they are', () => {
    const y = render(false), gaps = cuts.gaps();
    expect(gaps.length).toBeGreaterThan(20);
    for (const [a, b] of gaps.filter(([a, b]) => b - a > 0.01)) {
      expect(peak(y, a + 0.001, b - 0.001)).toBe(0);
      // Nothing is heard there, so nothing is drawn there.
      expect(cuts.heard(a + 0.001, b - 0.001)).toEqual([]);
    }
  });

  it('fills the gaps with the hit ringing on, never the next hit early', () => {
    // A held tone with a click on every cut: filled, the tone carries on through each gap and dies away,
    // and the next click is heard only where its piece starts.
    const x = new Float32Array(demo.x.length).map((_, i) => 0.3 * Math.sin((2 * Math.PI * 220 * i) / sr));
    for (const t of demo.onsets) x[Math.round(t * sr)] = 1;
    const go = (fill: boolean) => renderWarp({ chans: [x], sr, src: [...slow.src], dst: [...slow.dst], n, mode: 'beats', transients: demo.onsets, fill })[0];
    const y = go(true), dry = go(false), gaps = cuts.gaps().filter(([a, b]) => b - a > 0.01);
    expect(gaps.length).toBeGreaterThan(20);
    for (const [a, b] of gaps) {
      expect(peak(dry, a + 0.001, b - 0.001)).toBe(0);
      expect(peak(y, a + 0.001, a + 0.004)).toBeGreaterThan(0.1);
      // Only the tone is heard there: the click is at the piece's start and nowhere else.
      expect(peak(y, a, b)).toBeLessThanOrEqual(0.3 + 1e-6);
      // And it dies away into the next piece.
      expect(peak(y, b - 0.002, b)).toBeLessThan(peak(y, a + 0.001, a + 0.004));
    }
    // The hits are where they were.
    for (const p of cuts.pieces.slice(1, 40)) { const i = Math.round(p.d * sr); expect(y[i]).toBeCloseTo(dry[i], 6); }
  });
});
