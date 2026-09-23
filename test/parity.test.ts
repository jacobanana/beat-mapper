// The TypeScript core against the original single-file app, run side by side on the same input.
// Any difference in output, down to the last float or byte, fails. Once the core is meant to change
// behaviour on purpose, retire the affected case here and pin the new behaviour in the unit tests.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import Core from './legacy/core.legacy.js';
import { legacyUi } from './legacy/ui.legacy.js';
import { ALGOS, BANDS, type Analysis, analyze } from '../src/core/dsp/onset';
import { estimateTempo } from '../src/core/dsp/tempo';
import { snapToZero } from '../src/core/dsp/refine';
import { detectMarkers, filterMarkers, pickCandidates, sensToThr } from '../src/core/markers/detect';
import { autoMap, trackBeats } from '../src/core/beats/track';
import * as edit from '../src/core/beats/edit';
import { Grid, GRID_DIVISIONS } from '../src/core/tempo/meter';
import { TempoMap } from '../src/core/tempo/tempo-map';
import { planSlices, renderSlice } from '../src/core/slices/slices';
import { synthDemo } from '../src/core/demo';
import { buildMidi, planExport, type TempoResolution } from '../src/io/formats/midi';
import { buildRpp, buildRppSlices } from '../src/io/formats/rpp';
import { wavEncode } from '../src/io/formats/wav';
import { crc32, zipFiles } from '../src/io/formats/zip';
import type { Anchor, Candidate, Marker } from '../src/core/types';

const SR = 44100;
const demo = synthDemo(SR);
let an: Analysis;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let legacyAn: any;
let cands: Candidate[];
let markers: Marker[];

beforeAll(async () => {
  an = await analyze(demo.x, SR, { yieldToEventLoop: false });
  legacyAn = await Core.analyze(demo.x, SR);
  cands = pickCandidates(an, 'full', demo.x, SR, 'flux');
  const det = detectMarkers(cands, sensToThr(55), 0.06);
  markers = filterMarkers(cands, det, new Set(), []);
}, 60_000);

afterEach(() => vi.useRealTimers());

// Byte-for-byte comparison: much faster than toEqual on million-sample arrays, and stricter.
const sameFloats = (a: Float32Array, b: Float32Array) => {
  expect(a.length).toBe(b.length);
  expect(Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength))).toBe(true);
};
const plainCands = (cs: { t: number; s: number }[]) => cs.map((c) => ({ t: c.t, s: c.s }));

describe('analysis', () => {
  it('builds the same demo loop', () => {
    const d = Core.synthDemo(SR);
    sameFloats(demo.x, d.x);
    expect(demo.onsets).toEqual(d.onsets);
    expect(demo.beats).toEqual(d.beats);
  });

  it('computes identical detection functions', () => {
    for (const algo of ALGOS) for (const band of BANDS) sameFloats(an.odfs[algo][band], legacyAn.odfs[algo][band]);
    expect(an.fr).toBe(legacyAn.fr);
  });

  it('computes identical detection functions at high sample rates', async () => {
    const sr = 96000, x = new Float32Array(sr).map((_, i) => Math.sin(i * 0.01) * (i % 20000 < 300 ? 1 : 0.1));
    const a = await analyze(x, sr, { yieldToEventLoop: false }), b = await Core.analyze(x, sr);
    for (const algo of ALGOS) sameFloats(a.odfs[algo].full, b.odfs[algo].full);
  });

  it('picks the same candidates for every algorithm and band', () => {
    for (const algo of ALGOS) for (const band of BANDS) {
      expect(plainCands(pickCandidates(an, band, demo.x, SR, algo))).toEqual(plainCands(Core.pickCandidates(legacyAn, band, demo.x, SR, algo)));
    }
  });

  it('estimates the same tempo', () => {
    expect(estimateTempo(an.odfs.flux.full, an.fr)).toBe(Core.estimateTempo(legacyAn.odf.full, legacyAn.fr));
  });

  it('snaps to the same zero crossings', () => {
    for (let t = 0.1; t < 5; t += 0.0371) expect(snapToZero(demo.x, SR, t)).toBe(Core.snapToZero(demo.x, SR, t));
  });
});

describe('markers', () => {
  it('detects the same markers at every sensitivity and gap', () => {
    const legacy = Core.pickCandidates(legacyAn, 'full', demo.x, SR, 'flux');
    for (const sens of [0, 20, 55, 80, 100]) for (const gap of [0.01, 0.06, 0.3]) {
      const ours = detectMarkers(cands, sensToThr(sens), gap).map((i) => cands[i].t);
      expect(ours).toEqual(Core.detectMarkers(legacy, Core.sensToThr(sens), gap).map((c: Candidate) => c.t));
    }
  });

  it('filters removed and manual markers the same way', () => {
    const legacy = Core.pickCandidates(legacyAn, 'full', demo.x, SR, 'flux');
    const det = detectMarkers(cands, sensToThr(70), 0.04);
    const removed = new Set(det.filter((_, k) => k % 5 === 1));
    const manual = [{ id: 1, t: 3.21 }, { id: 2, t: cands[det[4]].t + 0.002 }, { id: 3, t: 0.05 }];
    const ours = filterMarkers(cands, det, removed, manual).map((m) => [m.t, m.manual]);
    const ldet = Core.detectMarkers(legacy, Core.sensToThr(70), 0.04);
    ldet.forEach((c: Candidate & { off?: boolean }, k: number) => { c.off = k % 5 === 1; });
    const theirs = Core.filterMarkers(ldet, manual.map((m) => ({ t: m.t, s: 1, manual: true }))).map((m: Marker) => [m.t, !!m.manual]);
    expect(ours).toEqual(theirs);
  });
});

describe('beat tracking', () => {
  const o = { stepQ: 1, beatQ: 1, tolFrac: 0.2, dur: demo.dur, stopT: 0 };
  it('tracks beats the same way in both directions', () => {
    const q0 = 8, t0 = markers[20].t;
    expect(trackBeats(markers, q0, t0, 0.62, 1, o)).toEqual(Core.trackBeats(markers, q0, t0, 0.62, 1, o));
    expect(trackBeats(markers, q0, t0, 0.62, -1, o)).toEqual(Core.trackBeats(markers, q0, t0, 0.62, -1, o));
  });

  it('auto-maps the same pins', () => {
    const pins = [{ q: 0, t: markers[0].t, manual: true }, { q: 16, t: demo.beats[16], manual: true }];
    for (const stepQ of [1, 4]) {
      const opts = { ...o, stepQ, spq: 0.62 };
      expect(autoMap(pins, markers, opts)).toEqual(Core.autoMap(pins, markers, opts));
      expect(autoMap(pins.slice(0, 1), markers, opts)).toEqual(Core.autoMap(pins.slice(0, 1), markers, opts));
    }
  });
});

// A legacy UI state holding the same tempo map, meter and markers.
const legacyState = (anchors: Anchor[], extra: object = {}) => ({
  x: demo.x, dur: demo.dur, num: 4, den: 4, grid: '16', baseBpm: 97, mapEvery: 'beat', tol: 20,
  anchors: anchors.map((a) => ({ ...a })), markers, loop: null, ...extra,
});
const sampleMaps = (): Anchor[][] => {
  const auto = autoMap([{ q: 0, t: markers[1].t }], markers, { stepQ: 1, beatQ: 1, tolFrac: 0.2, dur: demo.dur, spq: 0.62 });
  return [
    [{ q: 0, t: 0.372, manual: true }],
    [{ q: 0, t: 0.001, manual: true }, { q: 8, t: 5.1, manual: true }],
    auto,
    auto.filter((_, i) => i % 7 === 0),
  ];
};

describe('tempo map', () => {
  it('maps positions and times the same way', () => {
    for (const A of sampleMaps()) {
      const map = new TempoMap(A, 97), L = legacyUi(legacyState(A));
      for (let q = -3; q < 70; q += 0.37) expect(map.posToTime(q)).toBe(L.posToTime(q));
      for (let t = -0.5; t < demo.dur + 1; t += 0.113) {
        expect(map.timeToPos(t)).toBe(L.timeToPos(t));
        expect(map.bpmAt(t)).toBe(L.bpmAt(t));
      }
    }
  });

  it('lists the same bars', () => {
    for (const A of sampleMaps()) {
      const S = legacyState(A) as ReturnType<typeof legacyState> & { bars?: unknown };
      legacyUi(S).computeBars();
      expect(new TempoMap(A, 97).bars({ num: 4, den: 4 }, demo.dur)).toEqual(S.bars);
    }
  });

  it('finds the same grid lines for every division and meter', () => {
    for (const [num, den] of [[4, 4], [3, 4], [7, 8], [5, 16], [2, 2]]) for (const division of GRID_DIVISIONS) {
      const grid = new Grid({ num, den }, division), L = legacyUi({ ...legacyState([]), num, den, grid: division });
      expect(grid.stepQ).toBe(L.gridQ());
      for (let j = 0; j < 12; j++) expect(grid.level(j)).toBe(L.gridLevel(j));
      for (let q = -2; q < 20; q += 0.093) for (const lv of [0, 1, 2]) expect(grid.nearest(q, lv)).toBe(L.nearestGridQ(q, lv));
    }
  });
});

describe('pin edits', () => {
  const grid = new Grid({ num: 4, den: 4 }, '16');
  it('sets bar 1 the same way', () => {
    for (const A of sampleMaps()) for (const T of [0.2, 3.3, 9.87]) {
      const S = legacyState(A);
      legacyUi(S).setDownbeat(T);
      expect(edit.setDownbeat(new TempoMap(A, 97), grid, T)).toEqual(S.anchors);
    }
  });

  it('pins the same way, or refuses the same pins', () => {
    for (const A of sampleMaps()) for (const T of [0.1, 2.2, 4.44, 7.9, 12.5]) {
      const S = legacyState(A);
      const r = legacyUi(S).pinAt(T);
      const ours = edit.pinAt(new TempoMap(A, 97), grid, T);
      expect(ours.ok).toBe(r != null);
      if (ours.ok) { expect(ours.anchors).toEqual(S.anchors); expect(ours.pinned).toEqual(r); }
    }
  });

  it('auto-maps from the pins the same way', () => {
    for (const A of sampleMaps()) for (const mapEvery of ['beat', 'bar'] as const) {
      const S = legacyState(A, { mapEvery });
      legacyUi(S).autoMap();
      expect(edit.autoMapFromPins(new TempoMap(A, 97), markers, { num: 4, den: 4 }, { mapEvery, tol: 20 }, demo.dur)).toEqual(S.anchors);
    }
  });

  it('derives the same map from a loop', () => {
    const loops = [{ a: demo.beats[4], b: demo.beats[12] }, { a: 5.2, b: 7.9 }, { a: demo.beats[20] - 0.01, b: demo.beats[36] + 0.004 }];
    for (const A of [[], ...sampleMaps()]) for (const loop of loops) for (const loopBars of [undefined, 2, 4]) for (const mapEvery of ['beat', 'bar'] as const) {
      const S = legacyState(A, { loop, mapEvery });
      const L = legacyUi(S, { loopBars: loopBars == null ? '' : String(loopBars) });
      L.deriveFromLoop();
      const ours = edit.deriveFromLoop(new TempoMap(A, 97), markers, loop, { num: 4, den: 4 }, { mapEvery, tol: 20 }, demo.dur, loopBars);
      expect(ours.anchors).toEqual(S.anchors);
      expect(ours.baseBpm).toBe(S.baseBpm);
      const how = ours.how.kind === 'loop' ? `loop taken as ${ours.how.bars} bar${ours.how.bars > 1 ? 's' : ''}` : `${ours.how.count} pins in the loop kept`;
      expect(L.toasts[0]).toBe(`${ours.bpm.toFixed(2)} BPM · ${how} · ${ours.anchors.length} pins`);
    }
  });

  it('scales the tempo the same way', () => {
    for (const A of sampleMaps()) for (const f of [0.5, 2]) {
      const S = legacyState(A);
      legacyUi(S).scaleTempo(f);
      const ours = edit.scaleTempo(new TempoMap(A, 97).anchors, 97, f);
      expect(ours.anchors).toEqual(S.anchors);
      expect(ours.baseBpm).toBe(S.baseBpm);
    }
  });
});

describe('file formats', () => {
  const legacyOpts = (A: Anchor[], mode: TempoResolution, trimmed: boolean, clicks: boolean) => {
    const L = legacyUi(legacyState(A));
    return { anchors: A, baseBpm: 97, num: 4, den: 4, dur: demo.dur, mode, trimmed, clicks, posToTime: L.posToTime, timeToPos: L.timeToPos };
  };
  const ourOpts = (A: Anchor[], mode: TempoResolution, trimmed: boolean, clicks: boolean) =>
    ({ map: new TempoMap(A, 97), meter: { num: 4, den: 4 }, dur: demo.dur, mode, trimmed, clicks });
  const cases = function* () {
    for (const A of sampleMaps()) for (const mode of ['pins', 'bar', 'beat'] as const) for (const trimmed of [false, true]) for (const clicks of [false, true]) yield [A, mode, trimmed, clicks] as const;
  };

  it('writes identical MIDI files', () => {
    for (const c of cases()) {
      expect(planExport(ourOpts(...c))).toEqual(Core.planExport(legacyOpts(...c)));
      expect(buildMidi(ourOpts(...c)).bytes).toEqual(Core.buildExport(legacyOpts(...c)).bytes);
    }
  });

  it('writes identical REAPER projects', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    for (const c of cases()) {
      const extra = { fileName: 'take "1".wav', trackName: 'take' };
      expect(buildRpp({ ...ourOpts(...c), ...extra }).text).toBe(Core.buildRpp({ ...legacyOpts(...c), ...extra }).text);
      const slices = [{ t0: 0.3, t1: 0.5, name: 'a_01.wav' }, { t0: 0.5, t1: 0.9, name: "it's.wav" }];
      expect(buildRppSlices({ ...ourOpts(...c), slices, trackName: 'x' })).toBe(Core.buildRppSlices({ ...legacyOpts(...c), slices, trackName: 'x' }));
    }
    const none = { map: new TempoMap([], 97), meter: { num: 3, den: 8 }, dur: 5, mode: 'pins' as const, trimmed: false, slices: [] };
    expect(buildRppSlices(none)).toBe(Core.buildRppSlices({ anchors: [], baseBpm: 97, num: 3, den: 8, dur: 5, mode: 'pins', trimmed: false, slices: [] }));
  });

  it('writes identical WAV files', () => {
    const chans = [demo.x.subarray(0, 5000), demo.x.subarray(5000, 10000)];
    expect(wavEncode(chans, SR, 16)).toEqual(Core.wavEncode(chans, SR, 16));
    expect(wavEncode(chans, SR, 24)).toEqual(Core.wavEncode(chans, SR, 24));
    expect(wavEncode([demo.x.subarray(0, 999)], SR)).toEqual(Core.wavBytes(demo.x.subarray(0, 999), SR));
  });

  it('writes identical ZIP files', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 5, 14, 33, 21));
    const files = [{ name: 'a.txt', data: new TextEncoder().encode('hello') }, { name: 'dir/é.bin', data: new Uint8Array([1, 2, 3, 255]) }];
    expect(zipFiles(files)).toEqual(Core.zipFiles(files));
    expect(crc32(files[1].data)).toBe(Core.crc32(files[1].data));
  });
});

describe('slices', () => {
  it('plans the same slices', () => {
    const times = markers.map((m) => m.t);
    for (const mode of ['gap', 'fixed'] as const) for (const minLen of [0, 0.04, 0.3]) for (const [from, to] of [[0, demo.dur], [3.3, 9.1]]) {
      const o = { dur: demo.dur, from, to, minLen, mode, len: 0.5, tail: 0.02 };
      expect(planSlices(times, o)).toEqual(Core.planSlices(times, o));
    }
  });

  it('renders slices identically', () => {
    const chans = [demo.x, demo.x.map((v) => v * 0.5)];
    for (const o of [{}, { fadeIn: 0.001, fadeOut: 0.008 }, { mono: true, normalize: true, target: 0.5 }, { normalize: true }]) {
      expect(renderSlice(chans, SR, 1.234, 1.9, o)).toEqual(Core.renderSlice(chans, SR, 1.234, 1.9, o));
    }
  });
});
