import { describe, expect, it } from 'vitest';
import { synthDemo } from '../src/core/demo';
import { Grid } from '../src/core/tempo/meter';
import { TempoMap } from '../src/core/tempo/tempo-map';
import { planWarp, warpRange } from '../src/core/warp/map';
import { placeWarpMarker, quantizeTransients, removeWarpMarker, warpTempoMap, warpView } from '../src/core/warp/markers';
import { renderWarp } from '../src/core/warp/modes';

const sr = 22050;
const meter = { num: 4, den: 4 };
const demo = synthDemo(sr);
// Pinned on every true beat: the off-beat hats sit a few milliseconds either side of their eighth.
const demoMap = new TempoMap(demo.beats.map((t, i) => ({ q: i, t, manual: true })), 100);
const offBeats = demo.onsets.filter((t) => demo.beats.every((b) => Math.abs(b - t) > 0.05));

describe('warp markers', () => {
  it('put a transient exactly on its grid line when warped', () => {
    const hat = offBeats[9], q = Math.round(demoMap.timeToPos(hat) * 2) / 2;
    const before = planWarp(demoMap, warpRange(demoMap, meter, demo.dur, { lead: 'trim', loop: null }), 120);
    // Without a marker the loose hat lands off its eighth, by as much as it was played off it.
    expect(Math.abs(before.dstAt(hat) - q * 0.5)).toBeGreaterThan(0.0005);
    const r = placeWarpMarker([], hat, q);
    expect(r.ok).toBe(true);
    const map = warpTempoMap(demoMap, r.ok ? r.markers : []);
    const w = planWarp(map, warpRange(map, meter, demo.dur, { lead: 'trim', loop: null }), 120);
    expect(w.dstAt(hat)).toBeCloseTo(q * 0.5, 9);
    // The beats either side stay where the pins put them.
    expect(w.dstAt(demo.beats[Math.floor(q)])).toBeCloseTo(Math.floor(q) * 0.5, 9);
    expect(w.dstAt(demo.beats[Math.ceil(q)])).toBeCloseTo(Math.ceil(q) * 0.5, 9);
  });

  it('moves the sound itself: the hit is heard on the grid line', () => {
    const click = new Float32Array(sr * 2), at = 0.73, s0 = Math.round(at * sr);
    for (let i = 0; i < 2000; i++) click[s0 + i] = Math.sin(i * 0.3) * Math.exp(-i / 300);
    const map = warpTempoMap(new TempoMap([{ q: 0, t: 0, manual: true }, { q: 4, t: 2, manual: true }], 120), [{ t: at, q: 1.5 }]);
    const w = planWarp(map, { a: 0, b: 2, q0: 0 }, 120);
    const [y] = renderWarp({ chans: [click], sr, src: [...w.src], dst: [...w.dst], n: Math.round(w.outDur * sr), mode: 'beats', transients: [at] });
    const onset = y.findIndex((v) => Math.abs(v) > 0.1);
    expect(Math.abs(onset / sr - 0.75)).toBeLessThan(0.0005);
  });

  it('win over a pin they contradict, and never cross each other', () => {
    const map = new TempoMap([{ q: 0, t: 0, manual: true }, { q: 1, t: 0.5, manual: true }, { q: 2, t: 1, manual: true }], 120);
    // Beat 2 said to be at 0.55 s: the pin at 0.5 s gives way.
    const m = warpTempoMap(map, [{ t: 0.55, q: 1 }]);
    expect(m.anchors.map((a) => a.t).filter((t) => Math.abs(t) < 100)).toEqual([0, 0.55, 1]);
    // Before and after the pins it carries on at their tempo, however near an end a marker sits.
    const lead = warpTempoMap(map, [{ t: 0.3, q: 0.75 }]);
    expect(lead.timeToPos(-2)).toBeCloseTo(map.timeToPos(-2), 9);
    expect(lead.timeToPos(5)).toBeCloseTo(map.timeToPos(5), 9);
    // A marker later in time but earlier on the grid than another is refused.
    const first = placeWarpMarker([], 0.3, 0.5);
    expect(first.ok).toBe(true);
    expect(placeWarpMarker(first.ok ? first.markers : [], 0.4, 0.25)).toEqual({ ok: false, reason: 'crosses' });
    // The same transient dropped again is moved, not doubled.
    const again = placeWarpMarker(first.ok ? first.markers : [], 0.3, 0.75);
    expect(again.ok && again.markers).toEqual([{ t: 0.3, q: 0.75 }]);
    expect(removeWarpMarker([{ t: 0.3, q: 0.75 }], 0.3)).toEqual([]);
    expect(removeWarpMarker([{ t: 0.3, q: 0.75 }], 0.9)).toBeNull();
  });

  it('quantize every transient to its nearest line, the closer of two taking it', () => {
    const grid = new Grid(meter, '8');
    const ts = demo.onsets;
    const out = quantizeTransients(demoMap, grid, ts, { a: 0, b: demo.dur }, []);
    expect(out.length).toBe(ts.length);
    for (const w of out) expect(w.q * 2).toBeCloseTo(Math.round(w.q * 2), 9);
    // The whole take lined up: every hat lands on its eighth.
    const map = warpTempoMap(demoMap, out), wm = planWarp(map, warpRange(map, meter, demo.dur, { lead: 'trim', loop: null }), 120);
    for (const t of offBeats) expect((wm.dstAt(t) / 0.25) % 1).toBeCloseTo(0, 6);
    // A flam: two transients reaching for one line, the nearer one gets it.
    const flam = quantizeTransients(demoMap, grid, [demo.beats[4] - 0.02, demo.beats[4] + 0.005], { a: 0, b: demo.dur }, []);
    expect(flam).toEqual([{ t: demo.beats[4] + 0.005, q: 4 }]);
    // Markers already placed stay as they are.
    const kept = quantizeTransients(demoMap, grid, ts, { a: 0, b: demo.dur }, [{ t: offBeats[0], q: 0.75 }]);
    expect(kept.find((w) => w.t === offBeats[0])!.q).toBe(0.75);
  });

  it('quantizes part of the way at a lower strength, and not at all at 0', () => {
    const grid = new Grid(meter, '8'), ts = demo.onsets, all = { a: 0, b: demo.dur };
    const full = quantizeTransients(demoMap, grid, ts, all, []);
    const half = quantizeTransients(demoMap, grid, ts, all, [], 0.5);
    expect(half.length).toBe(full.length);
    half.forEach((w, i) => expect(w.q).toBeCloseTo((full[i].q + demoMap.timeToPos(w.t)) / 2, 9));
    expect(quantizeTransients(demoMap, grid, ts, all, [], 0)).toEqual([]);
  });
});

describe('shuffle', () => {
  it('swings every second line of a straight grid finer than the beat, up to a triplet', () => {
    const g8 = new Grid(meter, '8', 1), g16 = new Grid(meter, '16', 0.5);
    expect(g8.at(1)).toBeCloseTo(2 / 3, 9);
    expect(g8.at(2)).toBe(1);
    expect(g16.at(3)).toBeCloseTo(0.75 + 0.25 / 6, 9);
    // A late hat still finds its swung eighth; a straight one is nearer the swung line than the beat.
    expect(g8.nearest(0.62)).toBeCloseTo(2 / 3, 9);
    expect(g8.nearest(4.5)).toBeCloseTo(4 + 2 / 3, 9);
    // Nothing to swing: triplets and beats stay straight.
    expect(new Grid(meter, '8t', 1).at(1)).toBeCloseTo(1 / 3, 9);
    expect(new Grid(meter, '4', 1).at(1)).toBe(1);
    // Quantized onto the swung grid, the demo's off-beat hats land on the shuffle.
    const out = quantizeTransients(demoMap, g8, offBeats, { a: 0, b: demo.dur }, []);
    for (const w of out) expect(w.q % 1).toBeCloseTo(2 / 3, 9);
  });
});

describe('the warp as it is drawn', () => {
  it('keeps the grid where the tempo map has it and moves the audio onto it', () => {
    const out = quantizeTransients(demoMap, new Grid(meter, '8'), offBeats, { a: 0, b: demo.dur }, []);
    const v = warpView(demoMap, warpTempoMap(demoMap, out))!;
    // Each hat lined up is drawn on its eighth of the unchanged grid, and that is the hat drawn there.
    for (const w of out) {
      expect(v.shown(w.t)).toBeCloseTo(demoMap.posToTime(w.q), 9);
      expect(v.source(demoMap.posToTime(w.q))).toBeCloseTo(w.t, 9);
    }
    // The beats, pinned, stay put.
    for (const b of demo.beats.slice(1, -1)) expect(v.shown(b)).toBeCloseTo(b, 9);
    // With nothing lined up the audio is drawn where it is.
    expect(warpView(demoMap, warpTempoMap(demoMap, []))).toBeNull();
  });
});
