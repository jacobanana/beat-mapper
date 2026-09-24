// The app and its features end to end, without a browser: demo audio in, the same numbers the UI
// shows out. Playback is the only part not covered (it needs Web Audio).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { barQ } from '../src/core/tempo/meter';
import { buildMidi } from '../src/io/formats/midi';
import { noHitEdits } from '../src/core/drums/edit';
import { defaultWarp } from '../src/state/settings';
import { MemoryStore, type TestApp, createTestApp, demo, fakeBuffer, openDemo } from './helpers';

let t: TestApp;
beforeEach(async () => {
  t = createTestApp();
  await openDemo(t);
});

describe('opening audio', () => {
  it('analyses it and finds the transients', () => {
    expect(t.app.markers.length).toBe(128);
    expect(t.app.doc.tempo.baseBpm).toBe(96.5);
    expect(t.app.step).toBe(1);
    expect(t.app.view.range).toEqual({ a: 0, b: t.app.dur });
  });

  it('follows the detection settings', async () => {
    t.f.markers.setSensitivity(20);
    expect(t.app.markers.length).toBeLessThan(128);
    // the same settings the browser comparison ran with, and the count both apps showed there
    t.f.markers.setSensitivity(70);
    t.f.markers.setGap(120);
    await t.f.markers.setAlgo('complex');
    await t.f.markers.setBand('low');
    expect(t.app.markers.length).toBe(106);
  });
});

describe('markers', () => {
  it('adds, deletes, undoes and redoes', () => {
    const { app, f } = t, n = app.markers.length;
    f.markers.add(20.0123);
    expect(app.markers.length).toBe(n + 1);
    expect(app.selectedMarker()?.manual).toBe(true);
    f.markers.remove(app.markers[5]);
    expect(app.markers.length).toBe(n);
    expect(app.undo()).toBe(true);
    expect(app.markers.length).toBe(n + 1);
    expect(app.undo()).toBe(true);
    expect(app.markers.length).toBe(n);
    expect(app.redo()).toBe(true);
    expect(app.markers.length).toBe(n + 1);
  });

  it('refuses a marker right on top of another', () => {
    const { app, f } = t, n = app.markers.length;
    f.markers.add(app.markers[3].t + 0.001);
    expect(app.markers.length).toBe(n);
  });

  it('drags a detected marker as one undo step', () => {
    const { app, f } = t, m = app.markers[10], n = app.markers.length;
    app.checkpoint();
    const id = f.markers.toManual(m);
    f.markers.moveTo(id, m.t + 0.05);
    f.markers.moveTo(id, m.t + 0.03);
    f.markers.settle();
    expect(app.markers.length).toBe(n);
    expect(app.markers.find((k) => k.id === id)?.t).toBeCloseTo(m.t + 0.03);
    app.undo();
    expect(app.markers.find((k) => k.t === m.t)?.manual).toBe(false);
  });

  it('discards manual edits', () => {
    const { app, f } = t, n = app.markers.length;
    f.markers.remove(app.markers[0]);
    f.markers.add(30.5);
    f.markers.reset();
    expect(app.markers.length).toBe(n);
    expect(app.markers.every((m) => !m.manual)).toBe(true);
  });
});

describe('beats', () => {
  it('sets bar 1 on the first transient when entering Beats, and auto-maps', () => {
    const { app, f } = t;
    f.workflow.goTo(2);
    expect(app.doc.tempo.anchors).toEqual([{ q: 0, t: app.markers[0].t, manual: true }]);
    expect(t.toasts).toContain('Bar 1 set on the first transient');
    f.beats.autoMap();
    expect(app.doc.tempo.anchors.length).toBe(64);
    expect(app.bars.length).toBe(17);
    app.undo();
    expect(app.doc.tempo.anchors.length).toBe(1);
  });

  it('pins, refuses crossing pins, and unpins', () => {
    const { app, f } = t;
    f.workflow.goTo(2);
    const p = f.beats.pinAt(5.0);
    expect(p?.manual).toBe(true);
    expect(f.beats.pinAt(0.1)).toBeNull();
    expect(t.toasts.at(-1)).toMatch(/before bar 1/);
    f.beats.unpin(app.doc.tempo.anchors[0]);
    expect(t.toasts.at(-1)).toMatch(/Bar 1 stays pinned/);
    f.beats.unpin(p!);
    expect(app.doc.tempo.anchors.length).toBe(1);
  });

  it('derives the map from a loop', () => {
    const { app, f } = t;
    f.workflow.goTo(2);
    f.playback.setLoop({ a: 2.909, b: 7.876 }, true);
    f.beats.deriveFromLoop();
    expect(t.toasts.at(-1)).toMatch(/BPM · loop taken as 2 bars · \d+ pins/);
    expect(app.doc.tempo.baseBpm).toBeGreaterThan(90);
    expect(app.doc.tempo.anchors[0].q).toBe(0);
  });

  it('sets one steady tempo from the loop, bar 1 a whole number of bars before it, as one undo step', () => {
    const { app, f } = t;
    f.workflow.goTo(2);
    f.beats.autoMap();
    const mapped = app.doc.tempo;
    const a = app.markers[40].t, b = app.tempoMap.posToTime(app.tempoMap.timeToPos(a) + 16);
    f.playback.setLoop({ a, b }, true);
    expect(f.beats.loopBars()).toBe(4);
    f.beats.steadyFromLoop();
    const pins = app.doc.tempo.anchors;
    expect(pins).toHaveLength(1);
    expect(pins[0].q).toBe(0);
    expect(app.doc.tempo.baseBpm).toBeGreaterThan(90);
    expect(app.doc.tempo.baseBpm).toBeLessThan(106);
    // The loop's start is on a bar line of the steady map.
    const bars = app.timeline.posOf(a) / 4;
    expect(Math.abs(bars - Math.round(bars))).toBeLessThan(0.02);
    expect(t.toasts.at(-1)).toMatch(/^Steady \d+\.\d\d BPM · 4 bars from the loop/);
    app.undo();
    expect(app.doc.tempo).toBe(mapped);
  });

  it('changes the meter as an undoable edit', () => {
    const { app, f } = t;
    f.beats.setMeter({ num: 3 });
    expect(app.grid.barQ).toBe(3);
    app.undo();
    expect(app.grid.barQ).toBe(4);
  });
});

describe('loop', () => {
  it('loops the whole file when switched on with nothing drawn, and keeps a drawn loop', () => {
    const { app, f } = t;
    f.playback.toggleLoop();
    expect(app.transport.loopOn).toBe(true);
    expect(app.transport.loop).toEqual({ a: 0, b: app.dur });
    f.playback.toggleLoop();
    expect(app.transport.loopOn).toBe(false);
    f.playback.setLoop({ a: 2, b: 4 }, false);
    f.playback.toggleLoop();
    expect(app.transport.loop).toEqual({ a: 2, b: 4 });
    expect(app.transport.loopOn).toBe(true);
  });
});

describe('slices', () => {
  it('slices at every marker, inside the loop when it is on', () => {
    const { app, f } = t;
    expect(app.slices.length).toBe(app.markers.length);
    f.playback.setLoop({ a: 2, b: 7 }, true);
    expect(app.slices.length).toBeLessThan(20);
    expect(app.slices.every((s) => s.t0 >= 2 && s.t0 < 7)).toBe(true);
  });

  it('drops and keeps slices by their start time', () => {
    const { app, f } = t;
    f.slicer.toggle(3);
    expect(app.slices[3].off).toBe(true);
    // still dropped after the slices are re-planned
    f.slicer.update({ tail: 20 });
    expect(app.slices[3].off).toBe(true);
    f.slicer.keepAll();
    expect(app.slices.some((s) => s.off)).toBe(false);
  });

  it('cuts the slices from the warp when it is heard, and from the original when not', async () => {
    const { app, f } = t;
    f.workflow.goTo(2);
    f.beats.autoMap();
    f.workflow.goTo(4);
    expect(app.hearingWarp).toBe(true);
    // Only what the warp makes is cut: with bar 1 a few transients in and the file trimmed to it, the
    // lead-in goes, while the original is still cut whole.
    f.beats.setDownbeat(app.markers[4].t);
    app.set('export', { lead: 'trim' });
    const bar1 = app.tempoMap.posToTime(0);
    expect(app.slices[0].t0).toBeCloseTo(bar1, 9);
    f.warp.setListen(false);
    expect(app.slices.length).toBe(app.markers.length);
    f.warp.setListen(true);
    expect(app.slices.length).toBe(app.markers.length - 4);
    // Cut from the render, each slice where the warp puts it.
    const c = (await f.slicer['cut']())!, out = app.warpOut!, sl = app.slices[5];
    expect(c.out).toBe(out);
    expect(c.chans[0].length).toBe(Math.max(1, Math.round(out.plan.outDur * c.sr)));
    expect(c.at(sl.t0)).toBeCloseTo(out.plan.map.dstAt(sl.t0), 12);
    f.warp.setListen(false);
    const o = (await f.slicer['cut']())!;
    expect(o.out).toBeNull();
    expect(o.chans).toBe(app.audio!.chans);
    expect(o.at(sl.t0)).toBe(sl.t0);
  });

  it('remembers the selected slice across a re-plan', () => {
    const { app, f } = t;
    f.slicer.select(7);
    f.slicer.update({ mode: 'fixed' });
    expect(app.sliceIndex).toBe(7);
  });
});

describe('export', () => {
  it('writes the MIDI the map describes', () => {
    const { f } = t;
    f.workflow.goTo(2);
    f.beats.autoMap();
    const { info } = buildMidi(f.exports.options());
    // one tempo per pin, less the two neighbouring beats that land on the same microsecond value
    expect(info.count).toBe(63);
    expect(info.leadBars).toBe(1);
  });

  it('plans a warp onto a straight grid: the whole file from a bar line, or the loop alone', () => {
    const { app, f } = t;
    expect(f.warp.plan()).toBeNull();
    f.workflow.goTo(2);
    f.beats.autoMap();
    const p = f.warp.plan()!;
    // The demo drifts from 94 to 101 BPM; the grid takes the whole-number tempo it averages.
    expect(p.bpm).toBe(Math.round(p.avgBpm));
    expect(p.ratios[0]).toBeLessThan(1);
    expect(p.ratios[1]).toBeGreaterThan(1);
    // Bar 1 is the pin at the first transient, a bar of silence ahead of it holds the lead-in.
    expect(p.map.dstAt(app.markers[0].t)).toBeCloseTo((4 * 60) / p.bpm, 6);
    expect(f.warp.fileName(p)).toBe(`drifting-drum-loop_warped_${p.bpm}bpm.wav`);

    f.warp.update({ bpm: 100 });
    const b1 = app.tempoMap.posToTime(4), b3 = app.tempoMap.posToTime(12);
    f.playback.setLoop({ a: b1, b: b3 }, false);
    f.playback.toggleLoop();
    // A loop that is on is still not warped on its own until the Warp step says so.
    expect(f.warp.plan()!.loop).toBe(false);
    f.warp.setRange('loop');
    const l = f.warp.plan()!;
    expect(l.loop).toBe(true);
    expect(l.outDur).toBeCloseTo((8 * 60) / 100, 6);
    expect(f.warp.fileName(l)).toBe('drifting-drum-loop_2bars_100bpm_warped.wav');
  });
});

describe('the Warp step', () => {
  it('lines a transient up with the grid by dragging it, as one undo step', () => {
    const { app, f } = t;
    f.workflow.goTo(2);
    f.beats.autoMap();
    f.workflow.goTo(3);
    f.beats.setGrid('8');
    // An off-beat hat, a little loose: dragged onto the eighth nearest where it is let go.
    const hat = app.markers.find((m) => { const q = app.tempoMap.timeToPos(m.t); return Math.abs(q - Math.round(q) - 0.5) < 0.2; })!;
    const q = Math.round(app.tempoMap.timeToPos(hat.t) * 2) / 2, undos = app.history.canUndo;
    f.warp.grab(hat.t);
    f.warp.dragTo(app.tempoMap.posToTime(q) + 0.01);
    expect(app.warpDrag?.q).toBe(q);
    expect(app.doc.warpMarkers).toEqual([]);
    f.warp.drop();
    expect(app.warpDrag).toBeNull();
    expect(app.doc.warpMarkers).toEqual([{ t: hat.t, q }]);
    // Where the warp puts it: exactly on its eighth of the straight grid.
    const p = app.warpPlan!;
    expect(p.map.dstAt(hat.t)).toBeCloseTo(((q - p.q0) * 60) / p.bpm, 9);
    expect(f.warp.summary()).toContain('1 transient lined up');
    expect(f.warp.changed).toBe(true);
    // The tempo map of the Beats step is left as it was.
    expect(app.tempoMap.anchors.some((a) => a.t === hat.t)).toBe(false);
    app.undo();
    expect(app.doc.warpMarkers).toEqual([]);
    expect(app.history.canUndo).toBe(undos);
  });

  it('keeps warp markers placed by hand under the quantize, and resets both', () => {
    const { app, f } = t;
    f.workflow.goTo(2);
    f.beats.autoMap();
    f.workflow.goTo(3);
    f.beats.setGrid('8');
    f.warp.snap(app.markers[3].t);
    f.warp.snap(app.markers[7].t);
    const hand = app.doc.warpMarkers;
    expect(hand.length).toBe(2);
    f.warp.setQuantizeStrength(100);
    // The quantize is laid around them, and leaves the document as it was.
    expect(app.doc.warpMarkers).toBe(hand);
    expect(app.warpMarkers.length).toBeGreaterThan(100);
    for (const w of hand) expect(app.warpMarkers).toContainEqual(w);
    f.warp.remove(hand[0].t);
    expect(app.doc.warpMarkers.length).toBe(1);
    f.warp.reset();
    expect(app.doc.warpMarkers).toEqual([]);
    expect(app.warp.quantize).toBe(0);
    expect(app.warpMarkers).toEqual([]);
    expect(f.warp.changed).toBe(false);
    app.undo();
    expect(app.doc.warpMarkers.length).toBe(1);
  });

  it('draws Drums mode as it cuts: the hits whole where the warp puts them, and the gaps between', () => {
    const { app, f } = t;
    f.workflow.goTo(2);
    f.beats.autoMap();
    f.workflow.goTo(3);
    f.warp.update({ bpm: 90 });
    expect(app.warpPlan!.cuts).toBeNull();
    expect(app.timeline.gaps(0, app.dur)).toEqual([]);
    f.warp.setMode('beats');
    const p = app.warpPlan!, cuts = p.cuts!, tl = app.timeline;
    // Slowed down to 90 BPM, every hit has room to spare: a gap after each.
    expect(cuts.gaps().length).toBeGreaterThan(20);
    expect(tl.gaps(0, app.dur).length).toBe(cuts.gaps().length);
    expect(f.warp.summary()).toMatch(/\d+ gaps, longest \d+ ms/);
    // A hit is where the warp puts it, and the audio after it follows at its own speed, not stretched.
    const m = app.markers[10], k = cuts.pieces.find((c) => c.s === m.t)!;
    expect(app.warpOut!.at(m.t)).toBeCloseTo(p.map.dstAt(m.t), 9);
    expect(app.warpOut!.at(m.t + 0.02)).toBeCloseTo(k.d + 0.02, 9);
    expect(p.map.dstAt(m.t + 0.02)).not.toBeCloseTo(k.d + 0.02, 4);
    expect(app.warpOut!.source(k.d + 0.02)).toBeCloseTo(m.t + 0.02, 9);
    // Filling them is a setting of the step, which Reset puts back.
    f.warp.setFill(true);
    expect(f.warp.summary()).toContain('ms, filled');
    expect(f.warp.changed).toBe(true);
    f.warp.reset();
    expect(app.warp.fill).toBe(false);
  });

  it('quantizes as far as the strength says, on the grid and the shuffle as they are, without an edit', () => {
    const { app, f } = t;
    f.workflow.goTo(2);
    f.beats.autoMap();
    f.workflow.goTo(3);
    f.beats.setGrid('8');
    const doc = app.doc, undos = app.history.canUndo, plan = app.warpPlan;
    expect(app.warpMarkers).toEqual([]);
    f.warp.setQuantizeStrength(100);
    const full = app.warpMarkers;
    expect(full.length).toBeGreaterThan(100);
    // The warp follows, so what plays is rendered again.
    expect(app.warpPlan).not.toBe(plan);
    f.warp.setQuantizeStrength(50);
    const half = app.warpMarkers;
    expect(half.length).toBe(full.length);
    // Half way from where each transient sits to its line.
    half.forEach((w, i) => expect(w.q).toBeCloseTo((full[i].q + app.tempoMap.timeToPos(w.t)) / 2, 6));
    f.warp.setQuantizeStrength(100);
    // Every off-beat eighth swings two thirds of the way through its beat.
    f.beats.setShuffle(100);
    expect(app.warpMarkers.filter((w) => Math.abs((w.q % 1) - 2 / 3) < 1e-6).length).toBeGreaterThan(10);
    f.beats.setShuffle(0);
    expect(app.warpMarkers).toEqual(full);
    f.beats.setGrid('4');
    expect(app.warpMarkers.every((w) => Math.abs(w.q - Math.round(w.q)) < 1e-6)).toBe(true);
    f.warp.setQuantizeStrength(0);
    expect(app.warpMarkers).toEqual([]);
    // None of it is an edit: the document and undo are as they were.
    expect(app.doc).toBe(doc);
    expect(app.history.canUndo).toBe(undos);
  });

  it('draws the audio moved onto the grid in Warp, the grid staying put', () => {
    const { app, f } = t;
    f.workflow.goTo(2);
    f.beats.autoMap();
    f.workflow.goTo(3);
    f.beats.setGrid('8');
    expect(app.timeline.movesAudio).toBe(false);
    f.warp.setQuantizeStrength(100);
    const map = app.tempoMap, wm = app.warpMarkers, tl = app.timeline;
    expect(tl.movesAudio).toBe(true);
    for (const w of wm) {
      expect(tl.axisAt(w.t)).toBeCloseTo(map.posToTime(w.q), 9);
      expect(tl.sourceAt(map.posToTime(w.q))).toBeCloseTo(w.t, 9);
    }
    // A transient lined up and stopped on its grid line: the playhead lands on the transient.
    const loose = wm.find((w) => Math.abs(map.posToTime(w.q) - w.t) > 0.002)!;
    expect(f.playback.gridSnap(loose.t + 0.001)).toBeCloseTo(loose.t, 9);
    // Heard as it was played, the audio is drawn where it is; so it is in the other steps.
    f.warp.setListen(false);
    expect(app.timeline.axisAt(loose.t)).toBe(loose.t);
    f.warp.setListen(true);
    f.workflow.goTo(2);
    expect(app.timeline.axisAt(loose.t)).toBe(loose.t);
  });

  it('keeps the tempo while quantizing, its strength or the shuffle move', () => {
    const { app, f } = t;
    f.workflow.goTo(3);
    f.beats.setGrid('16');
    const p0 = app.warpPlan!, bars = app.bars;
    f.warp.setQuantizeStrength(100);
    expect(app.warpMarkers.length).toBeGreaterThan(50);
    for (const pct of [100, 40, 75]) {
      f.warp.setQuantizeStrength(pct);
      for (const sh of [0, 60]) {
        f.beats.setShuffle(sh);
        const p = app.warpPlan!;
        expect(p.avgBpm).toBeCloseTo(p0.avgBpm, 9);
        expect(p.bpm).toBe(p0.bpm);
        expect(app.bars).toBe(bars);
      }
    }
  });

  it('resets the shuffle and the quantize strength with the warp', () => {
    const { app, f } = t;
    f.workflow.goTo(2);
    f.beats.autoMap();
    f.workflow.goTo(3);
    f.beats.setShuffle(60);
    expect(f.warp.changed).toBe(true);
    f.warp.reset();
    expect(app.beats.shuffle).toBe(0);
    f.warp.setQuantizeStrength(40);
    expect(f.warp.changed).toBe(true);
    f.warp.reset();
    expect(app.warp.quantize).toBe(0);
    expect(f.warp.changed).toBe(false);
  });

  it('renders what plays again once the strength, the shuffle or the grid stop moving', () => {
    const { f } = t, pb = f.playback, plays: number[] = [];
    let take: object | null = {};
    // Playback needs Web Audio: stand in for it, with a take of the warp playing.
    Object.defineProperty(pb, 'playing', { get: () => true });
    Object.defineProperty(pb, 'playingTake', { get: () => take });
    pb.now = () => 1;
    pb.play = (from: number) => { plays.push(from); take = {}; };
    vi.useFakeTimers();
    try {
      f.workflow.goTo(2);
      f.beats.autoMap();
      f.workflow.goTo(3);
      vi.advanceTimersByTime(400);
      plays.length = 0;
      // A slider dragged: every step makes another warp, but only the last one is rendered.
      for (const pct of [10, 20, 30, 40, 50]) { f.warp.setQuantizeStrength(pct); vi.advanceTimersByTime(100); }
      expect(plays).toEqual([]);
      vi.advanceTimersByTime(300);
      expect(plays).toEqual([1]);
      for (const sh of [20, 40, 60]) { f.beats.setShuffle(sh); vi.advanceTimersByTime(100); }
      f.beats.setGrid('8');
      expect(plays).toEqual([1]);
      vi.advanceTimersByTime(400);
      expect(plays).toEqual([1, 1]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('plays it warped by default, and renders once until the warp changes', async () => {
    const { app, f } = t;
    f.workflow.goTo(2);
    f.beats.autoMap();
    f.warp.update({ mode: 'repitch' });
    expect(f.warpRender.wanted()).toBe(false);
    f.workflow.goTo(3);
    expect(app.warp.listen).toBe(true);
    expect(f.warpRender.wanted()).toBe(true);
    f.warp.toggleListen();
    expect(f.warpRender.wanted()).toBe(false);
    f.warp.toggleListen();
    const r = (await f.warpRender.render())!;
    expect(r.chans[0].length).toBe(Math.round(r.plan.outDur * 44100));
    // Nothing changed: the same render, for listening and for saving.
    expect(await f.warpRender.render()).toBe(r);
    // A pin moved (in Beats): rendered again.
    f.beats.nudge(app.doc.tempo.anchors[5], 0.01);
    const r2 = (await f.warpRender.render())!;
    expect(r2).not.toBe(r);
    expect(r2.plan).toBe(app.warpPlan);
    // Slice and Groove hear it too; Transients and Beats, the original the warp is made from.
    for (const step of [4, 5] as const) { f.workflow.goTo(step); expect(f.warpRender.wanted()).toBe(true); }
    for (const step of [1, 2] as const) { f.workflow.goTo(step); expect(f.warpRender.wanted()).toBe(false); }
  });

  it('switches to the warp while the original plays: entering Warp, and after quantizing', () => {
    const { f } = t, pb = f.playback, plays: number[] = [];
    let take: object | null = null;
    // Playback needs Web Audio: stand in for it, playing the original from the start.
    Object.defineProperty(pb, 'playing', { get: () => true });
    Object.defineProperty(pb, 'playingTake', { get: () => take });
    pb.now = () => 1;
    // Playing takes up the take wanted when it is made, else the original.
    pb.play = (from: number) => { plays.push(from); take = f.warpRender.wanted() ? f.warpRender.current() : null; };
    vi.useFakeTimers();
    try {
      f.workflow.goTo(2);
      f.beats.autoMap();
      expect(plays).toEqual([]);
      // In Warp, heard warped, with the original still playing and no take yet: once the edits settle,
      // play again from where it is, which renders the take and plays it.
      f.workflow.goTo(3);
      vi.advanceTimersByTime(400);
      expect(plays).toEqual([1]);
      // The take plays; quantizing makes it stale, so it is made again.
      take = {};
      f.warp.setQuantizeStrength(100);
      vi.advanceTimersByTime(400);
      expect(plays).toEqual([1, 1]);
      // Back in Beats, with the new take playing, the original is wanted again, at once.
      take = {};
      f.workflow.goTo(2);
      expect(plays).toEqual([1, 1, 1]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('takes the grid tempo from a looped section and warps the whole file to it', () => {
    const { app, f, toasts } = t;
    f.workflow.goTo(2);
    f.beats.autoMap();
    f.workflow.goTo(3);
    f.warp.fromLoop();
    expect(toasts.at(-1)).toMatch(/^Loop the section/);
    // Bars 13 to 17 are the demo's fastest.
    const map = app.tempoMap;
    f.playback.setLoop({ a: map.posToTime(48), b: map.posToTime(64) }, true);
    f.warp.fromLoop();
    const p = f.warp.plan()!;
    expect(p.bpm).toBe(Math.round((16 * 60) / (map.posToTime(64) - map.posToTime(48))));
    expect(p.bpm).toBeGreaterThan(Math.round(p.avgBpm));
    expect(p.loop).toBe(false);
    expect(p.srcDur).toBeCloseTo(app.dur, 6);
    expect(f.warp.summary()).toMatch(new RegExp(`^The file averages .* warped to ${p.bpm} BPM`));
    expect(f.workflow.canReset).toBe(true);
    f.workflow.resetStep();
    expect(app.warp).toEqual({ mode: 'music', bpm: null, range: 'file', listen: true, quantize: 0, fill: false });
  });
});

describe('what is heard', () => {
  it("tells whoever shows it when what is heard changes, whatever changed it", () => {
    const { app, f } = t, heard: number[] = [];
    app.bus.on('heard', () => heard.push(1));
    f.workflow.goTo(2);
    f.beats.autoMap();
    heard.length = 0;
    f.workflow.goTo(3);
    expect(heard.length).toBe(1);
    f.workflow.goTo(5);
    expect(heard.length).toBe(1);
    // The Warped switch in Groove changes what the pocket is measured on: its chart and summary hear of it.
    expect(app.warpOut).not.toBeNull();
    f.warp.toggleListen();
    expect(heard.length).toBe(2);
    expect(app.warpOut).toBeNull();
    f.warp.toggleListen();
    expect(heard.length).toBe(3);
    // Another grid tempo is another warp.
    f.warp.update({ bpm: 100 });
    expect(heard.length).toBe(4);
    // Nothing heard changes: nothing said.
    app.setPlayhead(3);
    f.warp.update({ bpm: 100 });
    expect(heard.length).toBe(4);
  });

  it("plays the original, says why and keeps the switch as it was when the warp can't be rendered", async () => {
    const { app, f, toasts } = t;
    f.workflow.goTo(2);
    f.beats.autoMap();
    f.workflow.goTo(3);
    const warp = vi.spyOn(f.warpRender['analyzer'], 'warp').mockRejectedValueOnce(new Error('too long'));
    expect(f.warpRender.wanted()).toBe(true);
    expect(await f.warpRender.prepare()).toBe(false);
    expect(toasts.at(-1)).toMatch(/^Couldn't warp the audio to play it – the original plays/);
    expect(app.warp.listen).toBe(true);
    expect(f.warpRender.wanted()).toBe(false);
    expect(f.warpRender.unavailable).toBe(true);
    // Slice and Groove still cut and measure the warp as it is set.
    expect(app.warpOut).not.toBeNull();
    // A change to the warp tries again.
    f.warp.update({ mode: 'repitch' });
    expect(f.warpRender.wanted()).toBe(true);
    expect(await f.warpRender.prepare()).toBe(true);
    warp.mockRestore();
  });
});

describe('resetting a step', () => {
  it('starts Transients again, and undo brings the marker edits back', async () => {
    const { app, f } = t, n = app.markers.length;
    expect(f.workflow.canReset).toBe(false);
    f.markers.add(30.5);
    f.markers.setSensitivity(80);
    await f.markers.setAlgo('complex');
    expect(f.workflow.canReset).toBe(true);
    f.workflow.resetStep();
    await new Promise((r) => setTimeout(r, 0));
    expect(app.detection).toMatchObject({ sens: 55, gap: 60, band: 'full', algo: 'flux' });
    expect(app.markers.length).toBe(n);
    expect(f.workflow.canReset).toBe(false);
    app.undo();
    expect(app.markers.some((m) => m.manual)).toBe(true);
  });

  it('starts Beats again from bar 1 on the first transient', () => {
    const { app, f } = t;
    f.workflow.goTo(2);
    expect(f.workflow.canReset).toBe(false);
    const bar1 = app.doc.tempo.anchors;
    f.beats.autoMap();
    f.beats.setMeter({ num: 3 });
    f.beats.setBaseBpm(120);
    expect(f.workflow.canReset).toBe(true);
    f.workflow.resetStep();
    expect(app.doc.tempo).toEqual({ anchors: bar1, baseBpm: 96.5 });
    expect(app.doc.meter).toEqual({ num: 4, den: 4 });
    expect(f.workflow.canReset).toBe(false);
    app.undo();
    expect(app.doc.meter.num).toBe(3);
    expect(app.doc.tempo.anchors.length).toBeGreaterThan(1);
  });

  it('starts Slice again with every slice kept', () => {
    const { app, f } = t;
    f.workflow.goTo(4);
    f.slicer.toggle(3);
    f.slicer.update({ mode: 'fixed', len: 250 });
    expect(f.workflow.canReset).toBe(true);
    f.workflow.resetStep();
    expect(app.excluded).toEqual([]);
    expect(app.slicer).toMatchObject({ mode: 'gap', len: 500 });
    expect(f.workflow.canReset).toBe(false);
  });

  it('starts Groove again with the hits as found', async () => {
    const { app, f } = t;
    f.workflow.goTo(5);
    await f.groove.ensureDrums();
    const kicks = app.drumHits!.kick.length;
    f.groove.removeHit('kick', app.drumHits!.kick[0].t);
    f.groove.setSensitivity('snare', 90);
    expect(f.workflow.canReset).toBe(true);
    f.workflow.resetStep();
    expect(app.drumHits!.kick.length).toBe(kicks);
    expect(app.groove.sens.snare).toBe(55);
    expect(f.workflow.canReset).toBe(false);
  });
});

describe('sessions', () => {
  it('saves the work to the browser and picks it up when the same audio is opened again', async () => {
    const store = new MemoryStore();
    const a = createTestApp(store);
    await openDemo(a);
    a.f.markers.add(12.3456);
    a.f.markers.remove(a.app.markers[2]);
    a.f.workflow.goTo(2);
    a.f.beats.autoMap();
    a.f.slicer.toggle(4);
    a.f.markers.setSensitivity(61);
    a.f.workflow.goTo(3);
    a.f.warp.snap(a.app.markers[5].t);
    a.f.warp.snap(a.app.markers[9].t);
    a.f.warp.setFill(true);
    a.f.workflow.goTo(2);
    a.f.sessions.autosave();
    expect([...store.map.keys()]).toEqual(['beatmapper:s:drifting-drum-loop.wav|40220', 'beatmapper:index']);

    const b = createTestApp(store);
    await openDemo(b);
    expect(b.toasts.at(-1)).toBe('Picked up where you left off');
    expect(b.app.markers.map((m) => [m.t, m.manual])).toEqual(a.app.markers.map((m) => [m.t, m.manual]));
    expect(b.app.doc.tempo).toEqual(a.app.doc.tempo);
    expect(b.app.doc.warpMarkers).toEqual(a.app.doc.warpMarkers);
    expect(b.app.doc.warpMarkers.length).toBe(2);
    expect(b.app.detection.sens).toBe(61);
    expect(b.app.step).toBe(2);
    expect(b.app.excluded).toEqual(a.app.excluded);
    expect(b.app.warp.fill).toBe(true);
    // nothing to undo right after a restore
    expect(b.app.undo()).toBe(false);
  });

  it('keeps the Warp step\'s settings and the hits edited by hand, and starts a new file from the defaults', async () => {
    const store = new MemoryStore();
    const a = createTestApp(store);
    await openDemo(a);
    a.f.workflow.goTo(2);
    a.f.beats.autoMap();
    a.f.workflow.goTo(3);
    a.f.warp.update({ bpm: 97, mode: 'beats', listen: false });
    a.f.workflow.goTo(5);
    await a.f.groove.ensureDrums();
    const kick = a.app.drumHits!.kick[0], snare = a.app.drumHits!.snare[1];
    a.f.groove.removeHit('kick', kick.t);
    a.f.groove.addHit('snare', snare.t + 0.2);
    a.f.sessions.autosave();

    const b = createTestApp(store);
    await openDemo(b);
    expect(b.app.warp).toEqual({ ...a.app.warp });
    expect(b.app.doc.drums.removed).toEqual(a.app.doc.drums.removed);
    expect(b.app.doc.drums.manual.map((h) => [h.voice, h.t])).toEqual(a.app.doc.drums.manual.map((h) => [h.voice, h.t]));
    await b.f.groove.ensureDrums();
    expect(b.app.drumHits).toEqual(a.app.drumHits);

    // Another file keeps nothing of the last one's warp: its grid tempo, material and switch.
    await b.f.loader.open(fakeBuffer([demo.x.slice(0, 44100 * 20)], 44100), 'other', 'other.wav', null);
    expect(b.app.warp).toEqual(defaultWarp());
    expect(b.app.doc.drums).toEqual(noHitEdits());
  });

  it('keeps sessions for the last eight files only', () => {
    const store = new MemoryStore();
    for (let i = 0; i < 10; i++) store.setItem('beatmapper:s:f' + i, '{}');
    store.setItem('beatmapper:index', JSON.stringify(Array.from({ length: 10 }, (_, i) => 'beatmapper:s:f' + i)));
    const a = createTestApp(store);
    return openDemo(a).then(() => {
      a.f.markers.add(3.3);
      a.f.sessions.autosave();
      const idx = JSON.parse(store.getItem('beatmapper:index')!);
      expect(idx.length).toBe(8);
      expect(idx[0]).toBe('beatmapper:s:drifting-drum-loop.wav|40220');
      expect(store.getItem('beatmapper:s:f9')).toBeNull();
    });
  });
});

describe('workflow', () => {
  it('opens a session saved in the old Export step in Warp, which came to have its number', () => {
    t.f.workflow.goTo(3);
    expect(t.app.step).toBe(3);
    expect(t.app.hasMap).toBe(true);
  });
});

describe('mixer', () => {
  it('keeps its levels in range, on this device and out of sessions', () => {
    const store = new MemoryStore();
    const a = createTestApp(store);
    expect(a.app.mix).toEqual({ audio: 100, click: 100, drums: 100 });
    a.f.mixer.setLevel('click', 60);
    a.f.mixer.setLevel('drums', 999);
    a.f.mixer.setLevel('audio', -5);
    expect(a.app.mix).toEqual({ audio: 0, click: 60, drums: 150 });
    expect(JSON.parse(store.getItem('beatmapper:mix')!)).toEqual(a.app.mix);
    expect(createTestApp(store).app.mix).toEqual(a.app.mix);
  });

  it('mutes a channel for this visit, keeping its level; the click\'s mute is its on/off', () => {
    const store = new MemoryStore();
    const a = createTestApp(store);
    a.f.mixer.setLevel('audio', 80);
    expect(a.f.mixer.isOn('audio')).toBe(true);
    expect(a.f.mixer.isOn('drums')).toBe(false);
    a.f.mixer.toggleMute('audio');
    expect(a.f.mixer.isOn('audio')).toBe(false);
    expect(a.f.playback.audioLevel).toBe(0);
    expect(a.app.mix.audio).toBe(80);
    a.f.mixer.toggleMute('audio');
    expect(a.f.playback.audioLevel).toBeCloseTo(0.72);
    expect(a.f.mixer.isOn('click')).toBe(false);
    a.f.mixer.toggleMute('click');
    expect(a.app.transport.click).toBe(true);
    a.f.mixer.toggleMute('audio');
    expect(createTestApp(store).f.mixer.isOn('audio')).toBe(true);
  });

  it('falls back to the defaults for anything unreadable it saved', () => {
    const store = new MemoryStore();
    store.setItem('beatmapper:mix', '{"audio":"loud","click":40.4}');
    expect(createTestApp(store).app.mix).toEqual({ audio: 100, click: 40, drums: 100 });
    store.setItem('beatmapper:mix', 'not json');
    expect(createTestApp(store).app.mix).toEqual({ audio: 100, click: 100, drums: 100 });
  });
});

describe('groove', () => {
  it('finds the demo loop\'s kick, snare and hats and measures their pocket', async () => {
    const { app, f } = t;
    f.workflow.goTo(2);
    f.beats.autoMap();
    f.workflow.goTo(5);
    await f.groove.ensureDrums();
    expect(app.step).toBe(5);
    const h = app.drumHits!;
    // 16 bars: kick on 1 and 3, snare on 2 and 4, hats on every eighth. The demo's hats are quiet
    // and those on the beat are buried under the kick and snare; the off-beat ones must all be there.
    expect(h.kick.length).toBe(32);
    expect(h.snare.length).toBe(32);
    expect(h.hat.length).toBeGreaterThanOrEqual(64);
    const g = app.pocket!;
    expect(g.bars).toBe(16);
    expect(g.ref).toBe('grid');
    // The demo plays every voice on the beat; only its off-beat hats wander (±4 ms).
    for (const v of g.voices) expect(Math.abs(v.median), v.voice).toBeLessThan(1.5);
    expect(f.groove.summary()).toMatch(/^16 bars · 9\d\.\d BPM/);
  });

  it('follows the settings', async () => {
    const { app, f } = t;
    f.workflow.goTo(5);
    await f.groove.ensureDrums();
    const n = app.drumHits!.hat.length;
    f.groove.setSensitivity('hat', 0);
    expect(app.drumHits!.hat.length).toBeLessThan(n);
    f.groove.setGrid('8');
    expect(app.pocket!.stepsPerBar).toBe(8);
    f.playback.setLoop({ a: app.tempoMap.posToTime(8), b: app.tempoMap.posToTime(16) }, true);
    expect(app.pocket!.bars).toBe(2);
  });

  it('measures the drums where the warp puts them: quantized in Warp, on the grid; the original, as played', async () => {
    const { app, f } = t;
    f.workflow.goTo(2);
    f.beats.autoMap();
    f.workflow.goTo(5);
    await f.groove.ensureDrums();
    f.workflow.goTo(3);
    f.beats.setGrid('16');
    f.warp.setQuantizeStrength(100);
    f.workflow.goTo(5);
    expect(app.hearingWarp).toBe(true);
    const out = app.warpOut!, g = app.pocket!, bq = barQ(app.doc.meter);
    expect(g.bpm).toBeCloseTo(out.plan.bpm, 6);
    // Each hit is measured on the warp's straight grid, where the warp puts it, and keeps its own time.
    for (const h of g.hits) {
      const heard = out.at(h.t), step = out.map.posToTime(h.bar * bq + h.step * 0.25);
      expect(h.gridMs).toBeCloseTo((heard - step) * 1000, 6);
      expect(app.drumHits![h.voice].some((k) => k.t === h.t)).toBe(true);
    }
    // A hit on a transient that Quantize lined up sits on its step.
    const lined = g.hits.filter((h) => app.warpMarkers.some((w) => Math.abs(w.t - h.t) < 1e-4));
    expect(lined.length).toBeGreaterThan(20);
    for (const h of lined) expect(Math.abs(h.gridMs)).toBeLessThan(0.2);
    // The original: the hits as played, on the tempo map, and the pocket is measured again.
    f.warp.setListen(false);
    expect(app.warpOut).toBeNull();
    const played = app.pocket!;
    expect(played).not.toBe(g);
    for (const h of played.hits.slice(0, 40)) expect(h.gridMs).toBeCloseTo((h.t - app.tempoMap.posToTime(h.bar * bq + h.step * 0.25)) * 1000, 6);
  });

  it('writes the drum MIDI as heard: warped at the grid tempo and lined up with the warped audio', async () => {
    const { app, f } = t;
    f.workflow.goTo(2);
    f.beats.autoMap();
    f.workflow.goTo(5);
    await f.groove.ensureDrums();
    const out = app.warpOut!, midi = f.groove.drumMidi()!;
    expect(midi.notes.length).toBe(app.pocket!.hits.length);
    app.pocket!.hits.forEach((h, i) => expect(midi.notes[i].t).toBeCloseTo(out.at(h.t), 9));
    // One tempo in the file: the grid's.
    expect(tempos(midi.bytes)).toEqual([Math.round(60e6 / out.plan.bpm)]);
    // Heard as the original, the notes are where they were played, on the tempo map's tempos.
    f.warp.setListen(false);
    const orig = f.groove.drumMidi()!;
    app.pocket!.hits.forEach((h, i) => expect(orig.notes[i].t).toBe(h.t));
    expect(tempos(orig.bytes).length).toBeGreaterThan(1);
  });

  it('turns the hits into notes to hear, and switches what is heard and charted', async () => {
    const { app, f } = t;
    f.workflow.goTo(5);
    await f.groove.ensureDrums();
    const h = app.drumHits!, notes = app.drumNotes;
    expect(notes.length).toBe(h.kick.length + h.snare.length + h.hat.length);
    for (let i = 1; i < notes.length; i++) expect(notes[i].t).toBeGreaterThanOrEqual(notes[i - 1].t);
    // Same velocities as the pocket gives each hit.
    const g = app.pocket!;
    for (const p of g.hits.slice(0, 20)) expect(notes.find((n) => n.voice === p.voice && n.t === p.t)?.vel).toBe(p.vel);
    expect(f.mixer.isOn('drums')).toBe(false);
    f.mixer.toggleMute('drums');
    expect(f.mixer.isOn('drums')).toBe(true);
    f.mixer.toggleMute('drums');
    expect(f.mixer.isOn('drums')).toBe(false);
    f.groove.toggleChart();
    expect(app.groove.chart).toBe('midi');
  });

  it('adds, moves and deletes hits by hand, on the transients, with undo', async () => {
    const { app, f } = t;
    f.workflow.goTo(2);
    f.beats.autoMap();
    f.workflow.goTo(5);
    await f.groove.ensureDrums();
    const n = app.drumHits!.kick.length, notes = app.drumNotes.length;
    // A kick where the detector heard none, aimed 10 ms off a transient: it lands on the transient.
    const m = app.markers.find((k) => !app.drumHits!.kick.some((h) => Math.abs(h.t - k.t) < 0.05))!;
    f.groove.addHit('kick', f.groove.alignToTransient(m.t + 0.01, 0.03));
    expect(app.drumHits!.kick.length).toBe(n + 1);
    expect(app.selectedHit()).toMatchObject({ voice: 'kick', t: m.t, id: 1 });
    expect(app.drumNotes.length).toBe(notes + 1);
    expect(app.pocket!.hits.some((h) => h.voice === 'kick' && h.t === m.t)).toBe(true);
    // One within 30 ms of it is the same hit.
    f.groove.addHit('kick', m.t + 0.02);
    expect(app.drumHits!.kick.length).toBe(n + 1);
    // Moving a detected hit makes it a placed one; the drag is one undo step.
    const first = app.drumHits!.snare[0];
    app.checkpoint();
    const id = f.groove.toManual('snare', first.t);
    f.groove.moveHitTo(id, first.t + 0.004);
    f.groove.moveHitTo(id, first.t + 0.008);
    expect(app.drumHits!.snare[0]).toMatchObject({ t: first.t + 0.008, id, a: first.a });
    expect(app.selectedHit()?.t).toBe(first.t + 0.008);
    app.undo();
    expect(app.drumHits!.snare[0]).toEqual(first);
    // Deleting a detected hit survives a change of sensitivity.
    const hat = app.drumHits!.hat[3];
    f.groove.removeHit('hat', hat.t);
    expect(app.drumHits!.hat.some((h) => h.t === hat.t)).toBe(false);
    f.groove.setSensitivity('hat', 80);
    expect(app.drumHits!.hat.some((h) => h.t === hat.t)).toBe(false);
    f.groove.resetHits();
    expect(app.drumHits!.hat.some((h) => h.t === hat.t)).toBe(true);
    expect(app.drumHits!.kick.length).toBe(n);
    app.undo();
    expect(app.drumHits!.kick.length).toBe(n + 1);
  });
});

/** The tempos a MIDI file sets, in microseconds per quarter note, in order. */
function tempos(bytes: Uint8Array): number[] {
  const out: number[] = [];
  for (let i = 0; i + 5 < bytes.length; i++)
    if (bytes[i] === 0xff && bytes[i + 1] === 0x51 && bytes[i + 2] === 3) out.push((bytes[i + 3] << 16) | (bytes[i + 4] << 8) | bytes[i + 5]);
  return out;
}
