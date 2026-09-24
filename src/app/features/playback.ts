// Playing, stopping, the start point, the loop, scrubbing and the metronome.
import { fmtTime } from '../../core/format';
import { beatQ } from '../../core/tempo/meter';
import { lowerBound, nearest } from '../../core/search';
import type { TimeRange } from '../../core/types';
import { type ClickSource, OneShot, Player, grain } from '../../engine/player';
import type { App } from '../app';

/**
 * Another take of the audio, played in its place on its own timeline: the warp, from the Warp step on.
 * The editor stays on the original's timeline, so positions are mapped both ways.
 */
export interface Take {
  buffer: AudioBuffer;
  /** Original time to the take's time, and back. */
  toTake(t: number): number;
  toSource(t: number): number;
  /** The metronome, on the take's timeline. */
  clicks: ClickSource;
}

/** Where a take comes from. Playback asks it on every play. */
export interface TakeSource {
  /** True when a take should play instead of the audio. */
  wanted(): boolean;
  /** The take, or null while it has not been made for the current state. */
  current(): Take | null;
  /** Makes the take; false when it couldn't be made. */
  prepare(): Promise<boolean>;
}

const STAY_ON = { markers: ' on the closest transient', grid: ' on the closest grid line', off: '' } as const;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export class Playback {
  private readonly player: Player;
  /** Slice previews. */
  readonly oneShot = new OneShot();
  private scrub: { lastG: number; lastPos: number } | null = null;
  private takes: TakeSource | null = null;
  /** The take playing, or null when it is the audio itself. */
  private take: Take | null = null;
  /** Counts plays and stops, so a play waiting on a take is dropped if anything came after it. */
  private gen = 0;

  constructor(private readonly app: App) {
    this.player = new Player({
      clicks: (a, b, emit) => this.clicksIn(a, b, emit),
      clicksOn: () => app.transport.click,
      // The notes are timed on the original; under the warp each plays where the warp puts its hit.
      hits: (a, b, emit) => {
        const N = app.drumNotes, k = this.take, s0 = k ? k.toSource(a) : a, s1 = k ? k.toSource(b) : b;
        for (let i = lowerBound(N, s0); i < N.length && N[i].t < s1; i++) emit(k ? k.toTake(N[i].t) : N[i].t, N[i].voice, N[i].vel);
      },
      // The synth kit only plays in the Groove step, where its drums are drawn.
      hitsOn: () => app.step === 5 && !!app.drums && !app.mute.drums,
      audioLevel: () => this.audioLevel,
      clickLevel: () => app.mix.click / 100,
      hitLevel: () => app.mix.drums / 100,
    });
    this.player.onEnded = () => { app.setPlayhead(app.dur, false); app.bus.emit('transport'); };
  }

  get playing(): boolean { return this.player.playing; }

  /** The take playing, or null when it is the audio itself (or nothing plays). */
  get playingTake(): Take | null { return this.player.playing ? this.take : null; }

  setTakeSource(s: TakeSource): void { this.takes = s; }

  // Where the sound is in the original audio.
  private position(): number {
    const p = this.player.position();
    return this.take ? this.take.toSource(p) : p;
  }

  /** The audio's gain, from the mixer: scrub grains and slice previews play at it too. */
  get audioLevel(): number { return this.app.mute.audio ? 0 : 0.9 * this.app.mix.audio / 100; }

  /** Where the sound is now: the player's position while playing, else the playhead. */
  now(): number {
    return this.player.playing ? this.position() : this.app.transport.playhead;
  }

  play(from: number): void {
    const { app } = this;
    if (!app.audio) return;
    const gen = ++this.gen, T = this.takes;
    // A take that is wanted but not made yet is made first. Whatever plays meanwhile carries on, so
    // after an edit the old take keeps playing until the new one is ready.
    if (T?.wanted() && !T.current()) {
      void T.prepare().then(() => {
        if (gen === this.gen) this.play(this.player.playing ? this.now() : from);
      });
      return;
    }
    this.stopPreview();
    this.stop(true);
    this.gen = gen;
    if (from >= app.dur - 0.01) from = 0;
    const take = T?.wanted() ? T.current() : null, L = app.transport.loopOn ? app.transport.loop : null;
    this.take = take;
    if (take) {
      const end = take.buffer.duration;
      this.player.play(take.buffer, Math.max(0, Math.min(end - 0.01, take.toTake(from))), L && { a: take.toTake(L.a), b: take.toTake(L.b) });
    } else this.player.play(app.audio.buffer, from, L);
    app.transport.playhead = from;
    app.bus.emit('transport', 'playhead');
  }

  /**
   * Stops. `stay` false: back to the start point. true: stays where it stopped. 'snap': stays, on
   * the closest transient or grid line (whichever the magnet is set to).
   */
  stop(stay: boolean | 'snap'): void {
    const { app } = this, t = app.transport;
    this.gen++;
    this.stopPreview();
    if (this.player.playing) {
      const p = this.position();
      this.player.stop();
      t.playhead = stay ? clamp(p, 0, app.dur) : t.start;
      if (!stay) app.reveal(t.start);
      else if (stay === 'snap') {
        const target = this.stopTarget(t.playhead);
        if (target) {
          t.playhead = target.t;
          if (target.id) app.select({ kind: 'marker', id: target.id });
          app.reveal(target.t);
        }
      }
    }
    this.player.stop();
    app.bus.emit('transport', 'playhead');
  }

  togglePlay(shift: boolean): void {
    if (this.player.playing) this.stop(this.app.transport.stay !== shift ? 'snap' : false);
    else this.play(this.app.transport.playhead);
  }

  // Where the playhead lands when it stays put on stop: the closest transient, the closest grid line,
  // or exactly where it stopped.
  private stopTarget(t: number): { t: number; id?: string } | null {
    const { app } = this, snap = app.beats.snapTo;
    if (snap === 'markers' && app.markers.length) { const m = nearest(app.markers, t); return m ? { t: m.t, id: m.id } : null; }
    if (snap === 'grid' && app.hasMap) return { t: this.gridSnap(t) };
    return null;
  }

  // Onto the grid line drawn nearest: the audio drawn on it, wherever the timeline draws the audio.
  gridSnap(t: number): number {
    const { app } = this, tl = app.timeline;
    return tl.map.isEmpty ? t : tl.sourceOfPos(app.grid.nearest(tl.posOf(t)));
  }

  toggleStay(): void {
    const t = this.app.transport;
    this.app.set('transport', { stay: !t.stay });
    this.app.notify.toast(this.app.transport.stay ? 'Stop: playhead stays' + STAY_ON[this.app.beats.snapTo] : 'Stop: playhead returns to start');
  }

  /** Enter: from the loop start, or the first transient. Shift+Enter: from the start point. */
  playFromStart(fromFlag: boolean): void {
    const { app } = this;
    if (!app.audio) return;
    const L = app.transport.loop;
    const t = fromFlag ? app.transport.start : app.transport.loopOn && L ? L.a : app.markers.length ? app.markers[0].t : 0;
    app.reveal(t);
    this.play(t);
  }

  /** Puts the playhead (and start point) at t; restarts playback from there unless `quiet`. */
  seek(t: number, quiet = false): void {
    this.app.setPlayhead(t);
    if (this.player.playing && !quiet) this.play(this.app.transport.playhead);
  }

  setStartHere(): void {
    const { app } = this;
    if (!app.audio) return;
    app.transport.start = clamp(this.now(), 0, app.dur);
    app.bus.emit('transport');
    app.notify.toast('Start point ' + fmtTime(app.transport.start));
  }

  toggleClick(): void { this.app.set('transport', { click: !this.app.transport.click }); }

  toggleScrub(): void {
    this.app.set('transport', { scrubMode: !this.app.transport.scrubMode });
    this.app.notify.toast(this.app.transport.scrubMode ? 'Scrub on' : 'Scrub off');
  }

  // In Transients and Slice the metronome clicks on every marker; elsewhere on the beats of the map.
  private clicksIn(a: number, b: number, fn: (t: number, down: boolean) => void): void {
    const { app } = this;
    if (this.take) this.take.clicks(a, b, fn);
    else if (app.step === 1 || app.step === 4) {
      const M = app.markers;
      for (let i = lowerBound(M, a); i < M.length && M[i].t < b; i++) fn(M[i].t, false);
    } else if (app.hasMap) {
      const map = app.tempoMap, bq = beatQ(app.doc.meter);
      for (let k = Math.max(0, Math.ceil(map.timeToPos(a) / bq - 1e-9)); k < 1e6; k++) {
        const t = map.posToTime(k * bq);
        if (t >= b) break;
        if (t >= a) fn(t, k % app.doc.meter.num === 0);
      }
    }
  }

  // ---------- loop ----------
  /** The loop changed: playback picks up the new one. */
  loopChanged(): void {
    if (this.player.playing) this.play(this.now());
    this.app.bus.emit('transport');
  }

  setLoop(loop: TimeRange | null, on = this.app.transport.loopOn): void {
    this.app.transport.loop = loop;
    this.app.transport.loopOn = on;
    this.loopChanged();
  }

  toggleLoop(): void {
    const { app } = this, L = app.transport.loop;
    if (!app.audio) return;
    // With nothing selected to loop, the whole file loops; the loop strip shows it, ready to narrow.
    if (!L || L.b - L.a < 0.01) {
      this.setLoop({ a: 0, b: app.dur }, true);
      app.notify.toast('Looping the whole file. Drag in the top ruler to loop less.');
    } else this.setLoop(L, !app.transport.loopOn);
  }

  /** I / O: loop start or end at the playhead. */
  setLoopEdge(which: 'a' | 'b'): void {
    const { app } = this;
    if (!app.audio) return;
    const t = clamp(this.now(), 0, app.dur), cur = app.transport.loop;
    const L = cur ? { ...cur } : which === 'a' ? { a: t, b: app.dur } : { a: 0, b: t };
    L[which] = t;
    if (L.b - L.a < 0.01) { if (which === 'a') L.b = app.dur; else L.a = 0; }
    this.setLoop(L, true);
  }

  /** Loops the bar under time t. */
  loopBarAt(t: number): boolean {
    const { app } = this, bar = app.timeline.barRangeAt(t, app.doc.meter, app.dur);
    if (!bar) return false;
    this.setLoop({ a: bar.a, b: bar.b }, true);
    app.notify.toast('Loop: bar ' + (bar.bar + 1));
    return true;
  }

  // ---------- scrub ----------
  scrubStart(t: number): void {
    if (this.player.playing) this.stop(true);
    this.scrub = { lastG: 0, lastPos: -1 };
    this.scrubTo(t);
  }

  /** Moves the playhead to t, sounding a grain at most every 45 ms. */
  scrubTo(t: number): void {
    const { app } = this;
    const s = this.scrub ?? (this.scrub = { lastG: 0, lastPos: -1 });
    t = clamp(t, 0, app.dur);
    app.setPlayhead(t);
    const n = performance.now();
    if (app.audio && n - s.lastG >= 45 && Math.abs(t - s.lastPos) > 1e-5) {
      grain(app.audio.buffer, t, undefined, this.audioLevel);
      s.lastG = n;
      s.lastPos = t;
    }
  }

  scrubEnd(): void { this.scrub = null; }

  /** , and . : step the playhead by 12 pixels (Shift: one) and hear it. */
  stepListen(dir: -1 | 1, fine: boolean): void {
    const { app } = this;
    if (!app.audio) return;
    if (this.player.playing) this.stop(true);
    const px = app.view.span / app.view.width;
    this.seek(app.transport.playhead + dir * px * (fine ? 1 : 12), true);
    app.reveal(app.transport.playhead);
    grain(app.audio.buffer, app.transport.playhead, 0.13, this.audioLevel);
  }

  stopPreview(): void {
    if (this.oneShot.stop()) this.app.bus.emit('playhead');
  }

  /** Called every animation frame: moves the playhead with the sound and keeps it on screen. */
  tick(followView: boolean): void {
    const { app } = this;
    if (this.player.playing) {
      const p = clamp(this.position(), 0, app.dur), v = app.view, sp = v.span, x = app.timeline.axisAt(p);
      app.transport.playhead = p;
      if (followView && (x > v.t0 + sp * 0.92 || x < v.t0)) app.setView(x - sp * 0.08, x + sp * 0.92);
      app.bus.emit('playhead');
    }
    const pv = this.oneShot.position();
    if (pv != null) { app.transport.playhead = pv; app.bus.emit('playhead'); }
  }
}
