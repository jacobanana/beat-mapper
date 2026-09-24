// What is drawn is what is heard. Every way of hearing the Warp step (the original, the warp, with no
// warp markers, quantized at full or part strength, on a swung grid) is checked against what the audio
// engine actually plays, and Slice and Groove hear what Warp does, worked out here without the timeline: the playhead is drawn on the grid
// position being heard, a click falls on a grid line drawn, a warp marker is drawn on its line, the
// readout names the bar heard at the tempo heard, and none of it moves the tempo map's bars or tempo.
import { beforeEach, describe, expect, it } from 'vitest';
import { barQ, beatQ } from '../src/core/tempo/meter';
import { gridBeats } from '../src/core/warp/map';
import { type TestApp, createTestApp, openDemo } from './helpers';

let t: TestApp;
beforeEach(async () => {
  t = createTestApp();
  await openDemo(t);
});

type Setup = { name: string; mapped: boolean; strength: number | null; shuffle: number; listen: boolean };
const SETUPS: Setup[] = [];
for (const mapped of [false, true])
  for (const strength of [null, 100, 40])
    for (const shuffle of [0, 60])
      for (const listen of [true, false])
        SETUPS.push({ name: `${mapped ? 'mapped' : 'bar 1 only'}, quantize ${strength ?? 'off'}, shuffle ${shuffle}, ${listen ? 'warped' : 'original'}`, mapped, strength, shuffle, listen });

// The beats mapped (or only bar 1), then the Warp step at 1/16.
function mapBeats(s: Setup): void {
  const { f } = t;
  f.workflow.goTo(2);
  if (s.mapped) f.beats.autoMap();
  f.workflow.goTo(3);
  f.beats.setGrid('16');
}

// What the Warp step is set to: shuffle, quantize and its strength, what is heard.
function arrange(s: Setup): void {
  const { f } = t;
  f.beats.setShuffle(s.shuffle);
  if (s.strength != null) {
    f.warp.setQuantizeStrength(s.strength);
    f.warp.toggleQuantize();
  }
  f.warp.setListen(s.listen);
}

const close = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe('the timeline', () => {
  for (const s of SETUPS) {
    it(`draws what is heard: ${s.name}`, () => {
      const { app, f } = t;
      mapBeats(s);
      const before = { bars: app.bars, map: app.tempoMap };
      arrange(s);
      const tl = app.timeline, map = app.tempoMap, meter = app.doc.meter, p = app.warpPlan!;
      expect(app.hearingWarp).toBe(s.listen);
      if (s.strength) expect(app.doc.warpMarkers.length).toBeGreaterThan(20);

      // The music is untouched: the same tempo map, the same bars.
      expect(map).toBe(before.map);
      expect(app.bars).toBe(before.bars);

      // What the engine plays at source time u, as a position: the warp plays it at its output time on
      // a straight grid, the original at the tempo map's position.
      const heard = (u: number) => (s.listen ? p.map.dstAt(u) * (p.bpm / 60) + p.q0 : map.timeToPos(u));
      for (let u = 0.5; u < app.dur - 0.5; u += 0.173) {
        const q = heard(u);
        // The playhead is drawn on the grid position heard, and read back from there.
        close(tl.axisAt(u), tl.axisOfPos(q));
        close(tl.posOf(u), q);
        close(tl.sourceAt(tl.axisAt(u)), u);
        // The readout names the bar and beat heard, at the tempo heard.
        const bb = tl.barBeatAt(u, meter), bq = barQ(meter), btq = beatQ(meter);
        if (bb && Math.abs(q / btq - Math.round(q / btq)) > 1e-6) {
          expect(bb.bar).toBe(Math.floor(q / bq + 1e-9));
          expect(bb.beat).toBe(Math.floor((q - bb.bar * bq) / btq + 1e-9));
        }
        close(tl.bpmAt(u), s.listen ? p.bpm : map.bpmAt(u), 1e-9);
        // Looping the bar heard loops the bar drawn.
        const bar = tl.barRangeAt(u, meter, app.dur);
        if (bar) close(tl.axisAt(bar.a), tl.axisOfPos(bar.bar * bq));
      }

      // Every click falls on a beat line drawn.
      const clicks: number[] = [];
      if (s.listen) gridBeats(p.q0, p.bpm, meter, 0, p.outDur, (o) => clicks.push(p.map.srcAt(o)));
      else f.playback['clicksIn'](0, app.dur, (u) => clicks.push(u));
      expect(clicks.length).toBeGreaterThan(50);
      for (const u of clicks) {
        const q = tl.posOf(u), beat = Math.round(q / beatQ(meter)) * beatQ(meter);
        close(tl.axisAt(u), tl.axisOfPos(beat));
      }

      // A warp marker is drawn on its line while the warp is heard.
      if (s.listen) for (const w of app.doc.warpMarkers) close(tl.axisAt(w.t), tl.axisOfPos(w.q));
    });
  }

  it('draws Slice and Groove as Warp when the warp is heard, and Transients and Beats always as the original', () => {
    const { app, f } = t;
    const s: Setup = { name: '', mapped: true, strength: 100, shuffle: 0, listen: true };
    mapBeats(s);
    arrange(s);
    for (const listen of [true, false]) {
      f.warp.setListen(listen);
      f.workflow.goTo(3);
      const w = app.timeline;
      for (const step of [4, 5] as const) {
        f.workflow.goTo(step);
        expect(app.hearingWarp).toBe(listen);
        for (let u = 0.5; u < app.dur - 0.5; u += 0.37) close(app.timeline.axisAt(u), w.axisAt(u));
      }
      for (const step of [1, 2] as const) {
        f.workflow.goTo(step);
        expect(app.hearingWarp).toBe(false);
        expect(app.timeline.movesAudio).toBe(false);
      }
    }
  });

  // What plays is what Playback tells the app (`app.playing`); these stand in for it without Web Audio.
  const mapped: Setup = { name: '', mapped: true, strength: 100, shuffle: 0, listen: true };

  it('draws the original while it still plays and the warp is being rendered', () => {
    const { app, f } = t;
    mapBeats(mapped);
    arrange(mapped);
    expect(app.hearingWarp).toBe(true);
    // Entering Warp mid-play: the original plays on until the take is ready.
    app.playing = { out: null };
    const tl = app.timeline, map = app.tempoMap, meter = app.doc.meter;
    expect(tl.movesAudio).toBe(false);
    for (let u = 0.5; u < app.dur - 0.5; u += 0.173) {
      close(tl.posOf(u), map.timeToPos(u));
      close(tl.bpmAt(u), map.bpmAt(u), 1e-9);
    }
    // Its clicks are the tempo map's beats, on the lines drawn.
    const clicks: number[] = [];
    f.playback['clicksIn'](0, app.dur, (u) => clicks.push(u));
    expect(clicks.length).toBeGreaterThan(50);
    for (const u of clicks) close(tl.axisAt(u), tl.axisOfPos(Math.round(tl.posOf(u) / beatQ(meter)) * beatQ(meter)));
    // Once it stops, what would play is drawn: the warp.
    app.playing = undefined;
    expect(app.timeline.movesAudio).toBe(true);
  });

  it('draws the take playing after an edit until the new one plays', () => {
    const { app, f } = t;
    mapBeats(mapped);
    arrange(mapped);
    const old = app.warpOut!;
    app.playing = { out: old };
    f.warp.setQuantizeStrength(30);
    expect(app.warpOut).not.toBe(old);
    // The old take is heard, so it is what is drawn: each moment on the position it plays at.
    const tl = app.timeline, p = old.plan;
    for (let u = 0.5; u < app.dur - 0.5; u += 0.173) close(tl.posOf(u), old.at(u) * (p.bpm / 60) + p.q0);
    // The new take plays: drawn as the new warp.
    app.playing = { out: app.warpOut };
    const now = app.warpOut!;
    for (let u = 0.5; u < app.dur - 0.5; u += 0.173) close(app.timeline.posOf(u), now.at(u) * (now.plan.bpm / 60) + now.plan.q0);
  });

  it('clicks the transients in Slice where the warp plays them', () => {
    const { app, f } = t;
    mapBeats(mapped);
    arrange(mapped);
    f.workflow.goTo(4);
    const out = app.warpOut!;
    f.playback['take'] = { buffer: null as unknown as AudioBuffer, out };
    const clicks: number[] = [];
    f.playback['clicksIn'](0, out.plan.outDur, (o) => clicks.push(o));
    const inside = app.markers.filter((m) => m.t >= out.range.a && m.t < out.range.b);
    expect(clicks.length).toBe(inside.length);
    clicks.forEach((o, i) => close(o, out.at(inside[i].t)));
  });

  it('keeps the tempo the warp is made at, whatever quantize, its strength and the shuffle do', () => {
    const { app } = t;
    mapBeats({ name: '', mapped: false, strength: null, shuffle: 0, listen: true });
    arrange({ name: '', mapped: false, strength: null, shuffle: 0, listen: true });
    const p0 = app.warpPlan!;
    arrange({ name: '', mapped: false, strength: 40, shuffle: 60, listen: true });
    expect(app.warpPlan!.avgBpm).toBeCloseTo(p0.avgBpm, 9);
    expect(app.warpPlan!.bpm).toBe(p0.bpm);
  });
});
