// The warp rendered: made in the worker once, then shared by what plays, the slices cut from it and
// the warped .wav, until something it depends on changes. It is also what makes the playing audio
// follow what is wanted: the warp from the Warp step on when the Warped switch is on, else the
// original.
import type { Analyzer } from '../../analysis/analyzer';
import { eachStep } from '../../core/tempo/tempo-map';
import { WARP_MODE_INFO, type WarpMode } from '../../core/warp/modes';
import { bufferFrom } from '../../engine/audio-context';
import type { App } from '../app';
import type { WarpOut, WarpPlan } from '../warp-out';
import type { Playback, Take, TakeSource } from './playback';

/** A render of the warp and everything it was made from, so hearing it, slicing it and saving it render it once. */
export interface Render {
  inputs: readonly unknown[];
  plan: WarpPlan;
  out: WarpOut;
  chans: Float32Array[];
  take: Take | null;
}

/** How long edits have to pause before a take made stale by them is made again. */
const SETTLE_MS = 350;

export class WarpRender implements TakeSource {
  private last: Render | null = null;
  private running: { inputs: readonly unknown[]; done: Promise<Render | null> } | null = null;
  private restart: { timer: ReturnType<typeof setTimeout>; inputs: readonly unknown[] } | null = null;
  /** What the last render that failed was made from: not tried again for playing until the warp changes. */
  private failed: readonly unknown[] | null = null;

  constructor(private readonly app: App, private readonly analyzer: Analyzer, private readonly playback: Playback) {
    playback.setTakeSource(this);
    // On every change, whatever it was: what plays follows what is wanted, so no list of causes to keep.
    app.bus.on('*', (topic) => { if (topic !== 'playhead') this.follow(); });
  }

  private plan(): WarpPlan | null { return this.app.warpPlan; }

  // ---------- the take ----------
  /** The warp should play: it is heard, and it hasn't just failed to render as it stands. */
  wanted(): boolean {
    const { app } = this;
    return app.hearingWarp && !(this.failed && same(this.failed, this.inputs(app.warpPlan!)));
  }

  /** The warp as it stands could not be rendered to play. */
  get unavailable(): boolean { return this.app.hearingWarp && !this.wanted(); }

  current(): Take | null {
    const r = this.fresh();
    if (!r) return null;
    return (r.take ??= { buffer: bufferFrom(r.chans, this.app.audio!.sr), out: r.out });
  }

  async prepare(): Promise<boolean> {
    const p = this.plan();
    try {
      return !!(await this.render());
    } catch (e) {
      console.error(e);
      // The switch stays as it was set: the original plays until the warp changes, and says why.
      if (p) this.failed = this.inputs(p);
      this.app.notify.toast("Couldn't warp the audio to play it – the original plays. Loop a shorter part and try again.");
      this.app.bus.emit('warp');
      return false;
    }
  }

  // Switches what plays when it no longer matches what is wanted. A take made stale by an edit is
  // remade once the edits settle, so a run of nudges costs one render.
  private follow(): void {
    const { app, playback: pb } = this;
    // A render of another file is only memory now.
    if (this.last && this.last.inputs[0] !== app.audio) this.last = null;
    if (!pb.playing) return this.settle(null);
    const want = this.wanted(), take = want ? this.current() : null;
    // Nothing to switch when what plays is what is wanted. A take wanted but not rendered yet is not the
    // original playing, though neither is a take: comparing them alone left the original playing.
    if (want ? !!take && pb.playingTake === take : !pb.playingTake) return this.settle(null);
    if (!want || take) {
      this.settle(null);
      return pb.play(pb.now());
    }
    // Wanted, not made: wait for the edits to settle, starting the wait again only when the warp
    // changes, not on every event while it waits.
    const inputs = this.inputs(this.plan()!);
    if (!this.restart || !same(this.restart.inputs, inputs)) this.settle(inputs);
  }

  private settle(inputs: readonly unknown[] | null): void {
    if (this.restart) clearTimeout(this.restart.timer);
    this.restart = null;
    if (!inputs) return;
    const timer = setTimeout(() => {
      this.restart = null;
      const pb = this.playback;
      if (this.app.dragging) return this.settle(inputs);
      if (pb.playing && this.wanted() && !this.current()) pb.play(pb.now());
    }, SETTLE_MS);
    this.restart = { timer, inputs };
  }

  // ---------- rendering ----------
  // Everything a render depends on; a render is reused while each of these is the same object or value.
  private inputs(p: WarpPlan): unknown[] {
    const { app } = this, mode = app.warp.mode;
    return [app.audio, p, mode, mode === 'beats' ? app.markers : null];
  }

  private fresh(): Render | null {
    const p = this.plan(), r = this.last;
    return p && r && same(r.inputs, this.inputs(p)) ? r : null;
  }

  // Where Drums mode cuts: the transients of step 1, or the sixteenths of the tempo map when there are none.
  private transients(): number[] {
    const { app } = this, m = app.markers;
    if (m.length) return m.map((k) => k.t);
    const out: number[] = [];
    eachStep(app.tempoMap, 0.25, 0, app.dur, (t) => out.push(t), 100000);
    return out;
  }

  /** The warp as it stands, rendered unless the last render still holds. Null without a plan, or if an edit overtook it. */
  async render(): Promise<Render | null> {
    const { app } = this, a = app.audio, p = this.plan();
    if (!a || !p) return null;
    const hit = this.fresh();
    if (hit) return hit;
    const inputs = this.inputs(p);
    if (this.running && same(this.running.inputs, inputs)) return this.running.done;
    const done: Promise<Render | null> = this.renderNow(p, inputs).finally(() => { if (this.running?.done === done) this.running = null; });
    this.running = { inputs, done };
    return done;
  }

  private async renderNow(p: WarpPlan, inputs: readonly unknown[]): Promise<Render | null> {
    const { app } = this, a = app.audio!, mode: WarpMode = app.warp.mode, label = 'Warping · ' + WARP_MODE_INFO[mode].label;
    app.notify.busy(label, 0.01);
    try {
      const n = Math.max(1, Math.round(p.outDur * a.sr));
      // Only the part being warped goes to the worker, with half a second either side for the frames
      // that reach past its ends; times are moved to match.
      const len = a.chans[0].length, s0 = Math.max(0, Math.floor((p.range.a - 0.5) * a.sr));
      const s1 = Math.min(len, Math.ceil((p.range.b + 0.5) * a.sr)), off = s0 / a.sr;
      const transients = mode === 'beats' ? this.transients().filter((t) => t >= off && t < s1 / a.sr).map((t) => t - off) : [];
      const chans = await this.analyzer.warp(
        { chans: a.chans.map((c) => c.subarray(s0, s1)), sr: a.sr, src: p.map.src.map((t) => t - off), dst: [...p.map.dst], n, mode, transients },
        (f) => app.notify.busy(label, 0.01 + 0.97 * f),
      );
      const r: Render = { inputs, plan: p, out: app.outOf(p), chans, take: null };
      if (this.failed && same(this.failed, inputs)) this.failed = null;
      // Kept unless a render of something newer landed first.
      if (!this.fresh()) this.last = r;
      return this.fresh() === r ? r : null;
    } finally {
      app.notify.idle();
    }
  }
}

const same = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((v, i) => v === b[i]);
