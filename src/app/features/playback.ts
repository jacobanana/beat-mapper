// Playing, stopping, the start point, the loop, scrubbing and the metronome.
import { fmtTime } from '../../core/format';
import { beatQ } from '../../core/tempo/meter';
import { lowerBound, nearest } from '../../core/search';
import type { TimeRange } from '../../core/types';
import { OneShot, Player, grain } from '../../engine/player';
import type { App } from '../app';

const STAY_ON = { markers: ' on the closest transient', grid: ' on the closest grid line', off: '' } as const;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export class Playback {
  private readonly player: Player;
  /** Slice previews. */
  readonly oneShot = new OneShot();
  private scrub: { lastG: number; lastPos: number } | null = null;

  constructor(private readonly app: App) {
    // The synth kit only plays in the Groove step, so the audio is never left muted elsewhere.
    const listen = () => (app.step === 5 && app.drums ? app.groove.listen : 'audio');
    this.player = new Player({
      clicks: (a, b, emit) => this.clicksIn(a, b, emit),
      clicksOn: () => app.transport.click,
      hits: (a, b, emit) => {
        const N = app.drumNotes;
        for (let i = lowerBound(N, a); i < N.length && N[i].t < b; i++) emit(N[i].t, N[i].voice, N[i].vel);
      },
      hitsOn: () => listen() !== 'audio',
      audioLevel: () => (listen() === 'midi' ? 0 : this.audioLevel),
      clickLevel: () => app.mix.click / 100,
      hitLevel: () => app.mix.drums / 100,
    });
    this.player.onEnded = () => { app.setPlayhead(app.dur, false); app.bus.emit('transport'); };
  }

  get playing(): boolean { return this.player.playing; }

  /** The audio's gain, from the mixer: scrub grains and slice previews play at it too. */
  get audioLevel(): number { return 0.9 * this.app.mix.audio / 100; }

  /** Where the sound is now: the player's position while playing, else the playhead. */
  now(): number {
    return this.player.playing ? this.player.position() : this.app.transport.playhead;
  }

  play(from: number): void {
    const { app } = this;
    if (!app.audio) return;
    this.stopPreview();
    this.stop(true);
    if (from >= app.dur - 0.01) from = 0;
    this.player.play(app.audio.buffer, from, app.transport.loopOn ? app.transport.loop : null);
    app.transport.playhead = from;
    app.bus.emit('transport', 'playhead');
  }

  /**
   * Stops. `stay` false: back to the start point. true: stays where it stopped. 'snap': stays, on
   * the closest transient or grid line (whichever the magnet is set to).
   */
  stop(stay: boolean | 'snap'): void {
    const { app } = this, t = app.transport;
    this.stopPreview();
    if (this.player.playing) {
      const p = this.player.stop();
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

  gridSnap(t: number): number {
    const { app } = this, map = app.tempoMap;
    return map.isEmpty ? t : map.posToTime(app.grid.nearest(map.timeToPos(t)));
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
    if (app.step === 1 || app.step === 4) {
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
    if (!L || L.b - L.a < 0.01) {
      const bar = app.tempoMap.barRangeAt(app.transport.playhead, app.doc.meter, app.dur);
      const t = app.transport.playhead;
      this.setLoop(bar ? { a: bar.a, b: bar.b } : { a: t, b: Math.min(app.dur, t + 2) }, true);
      app.notify.toast(app.hasMap ? 'Looping this bar. Drag in the bar ruler to change it.' : 'Looping 2 seconds. Drag in the top ruler to change it.');
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
    const { app } = this, bar = app.tempoMap.barRangeAt(t, app.doc.meter, app.dur);
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
      const p = clamp(this.player.position(), 0, app.dur), v = app.view, sp = v.span;
      app.transport.playhead = p;
      if (followView && (p > v.t0 + sp * 0.92 || p < v.t0)) app.setView(p - sp * 0.08, p + sp * 0.92);
      app.bus.emit('playhead');
    }
    const pv = this.oneShot.position();
    if (pv != null) { app.transport.playhead = pv; app.bus.emit('playhead'); }
  }
}
