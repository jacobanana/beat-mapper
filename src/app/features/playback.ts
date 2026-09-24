// Playing, stopping, the start point, the loop, scrubbing and the metronome.
import { fmtTime } from '../../core/format';
import { lowerBound, nearest } from '../../core/search';
import type { TimeRange } from '../../core/types';
import { beatsOf } from '../../core/warp/map';
import { OneShot, Player, grain } from '../../engine/player';
import { type App, usableLoop } from '../app';
import { stepRules } from '../steps';
import type { WarpOut } from '../warp-out';

/**
 * Another take of the audio, played in its place on its own timeline: the warp, from the Warp step on.
 * The editor stays on the original's timeline, so positions are mapped both ways by `out`.
 */
export interface Take {
  buffer: AudioBuffer;
  /** The warp it is: where the original lands in it (`at`), and back (`source`), and its grid. */
  out: WarpOut;
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
      hits: (a, b, emit) => this.eachHeard(app.drumNotes, a, b, (n, t) => emit(t, n.voice, n.vel)),
      // The synth kit only plays where its drums are drawn.
      hitsOn: () => this.kitOn,
      audioLevel: () => this.audioLevel,
      clickLevel: () => app.mix.click / 100,
      hitLevel: () => app.mix.drums / 100,
    });
    this.player.onEnded = () => { app.playing = undefined; app.setPlayhead(app.dur, false); app.bus.emit('transport'); };
  }

  /** The synth kit is heard: in a step that plays it, once the drums are found, and not muted. */
  get kitOn(): boolean { return this.kitLive && !this.app.mute.drums; }
  /** The synth kit would be heard here, muted or not. */
  get kitLive(): boolean { return stepRules(this.app.step).kit && !!this.app.drums; }

  // Every item timed on the original that plays between the player's times a and b, at the player's
  // time it plays at: the same moment under the warp, where the warp puts it.
  private eachHeard<T extends { t: number }>(list: readonly T[], a: number, b: number, emit: (x: T, t: number) => void): void {
    const o = this.take?.out, s0 = o ? o.source(a) : a, s1 = o ? o.source(b) : b;
    for (let i = lowerBound(list, s0); i < list.length && list[i].t < s1; i++) emit(list[i], o ? o.at(list[i].t) : list[i].t);
  }

  get playing(): boolean { return this.player.playing; }

  /** The take playing, or null when it is the audio itself (or nothing plays). */
  get playingTake(): Take | null { return this.player.playing ? this.take : null; }

  setTakeSource(s: TakeSource): void { this.takes = s; }

  // Where the sound is in the original audio.
  private position(): number {
    const p = this.player.position();
    return this.take ? this.take.out.source(p) : p;
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
    const take = T?.wanted() ? T.current() : null, L = app.activeLoop;
    this.take = take;
    if (take) {
      const end = take.buffer.duration, at = (t: number) => clamp(take.out.at(t), 0, end);
      this.player.play(take.buffer, Math.min(end - 0.01, at(from)), L && { a: at(L.a), b: at(L.b) });
    } else this.player.play(app.audio.buffer, from, L);
    // What plays now: the editor draws it, until it stops or something else plays.
    app.playing = { out: take?.out ?? null };
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
    app.playing = undefined;
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

  // The metronome, between the player's times a and b: on every transient where the step says so,
  // else on the beats of the grid heard, the warp's straight one or the tempo map's, lead-in included.
  private clicksIn(a: number, b: number, fn: (t: number, down: boolean) => void): void {
    const { app } = this, o = this.take?.out;
    if (stepRules(app.step).clicks === 'transients') this.eachHeard(app.markers, a, b, (_, t) => fn(t, false));
    else if (o) o.beats(a, b, fn);
    else if (app.hasMap) beatsOf(app.tempoMap, app.doc.meter, a, b, fn);
  }

  // What a grain of the audio at original time t sounds from: the take heard when there is one ready,
  // so a scrub in Re-pitch has the pitch that plays; else the original.
  private grainAt(t: number, len: number | undefined): void {
    const { app } = this, T = this.takes, take = T?.wanted() ? T.current() : null;
    if (take) grain(take.buffer, clamp(take.out.at(t), 0, take.buffer.duration), len, this.audioLevel);
    else if (app.audio) grain(app.audio.buffer, t, len, this.audioLevel);
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
    const { app } = this, L = usableLoop(app.transport.loop);
    if (!app.audio) return;
    // With nothing selected to loop, the whole file loops; the loop strip shows it, ready to narrow.
    if (!L) {
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
    if (!usableLoop(L)) { if (which === 'a') L.b = app.dur; else L.a = 0; }
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
      this.grainAt(t, undefined);
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
    this.grainAt(app.transport.playhead, 0.13);
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
