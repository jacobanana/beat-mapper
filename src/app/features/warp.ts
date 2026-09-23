// Warping: the audio re-timed so that the tempo map becomes a straight grid, heard in the Beats step
// and saved as a .wav that drops into a DAW at a steady tempo. The loop, when it is on, is warped on
// its own.
import { fmtBpm, safeName } from '../../core/format';
import { renderSlice } from '../../core/slices/slices';
import { barQ } from '../../core/tempo/meter';
import { gridBeats } from '../../core/warp/map';
import { WARP_MODE_INFO, type WarpMode } from '../../core/warp/modes';
import type { Analyzer } from '../../analysis/analyzer';
import { bufferFrom } from '../../engine/audio-context';
import { saveError, saveFile } from '../../io/download';
import { wavEncode } from '../../io/formats/wav';
import { type WarpSettings, defaultWarp } from '../../state/settings';
import type { App, WarpPlan } from '../app';
import type { Beats } from './beats';
import type { Playback, Take, TakeSource } from './playback';
import type { Slicer } from './slicer';

export type { WarpPlan } from '../app';

/** A render of the warp and everything it was made from, so hearing it and saving it render it once. */
interface Render {
  inputs: readonly unknown[];
  plan: WarpPlan;
  chans: Float32Array[];
  take: Take | null;
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export class Warp implements TakeSource {
  private last: Render | null = null;
  private running: { inputs: readonly unknown[]; done: Promise<Render | null> } | null = null;
  private restart: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly app: App,
    private readonly analyzer: Analyzer,
    private readonly beats: Beats,
    private readonly slicer: Slicer,
    private readonly playback: Playback,
  ) {
    playback.setTakeSource(this);
    // What plays follows what is wanted: the original outside Beats or with listening off, and a fresh
    // take after an edit changes the warp.
    app.bus.on(['doc', 'warp', 'export', 'transport', 'step', 'candidates', 'detection', 'audio'], () => this.follow());
  }

  update(patch: Partial<WarpSettings>): void { this.app.set('warp', patch); }

  /** What would be warped, and how, or null when there is no tempo map yet. */
  plan(): WarpPlan | null { return this.app.warpPlan; }

  setMode(mode: WarpMode): void {
    this.update({ mode });
    if (this.app.warp.listen) this.app.notify.toast(WARP_MODE_INFO[mode].label + ': ' + WARP_MODE_INFO[mode].desc);
  }

  /** W: hear the audio warped onto the grid, or the original again. */
  toggleListen(): void {
    const { app } = this;
    if (!app.warp.listen && !this.plan()) return app.notify.toast('Set bar 1 first (D), then map the beats.');
    this.update({ listen: !app.warp.listen });
    const p = this.plan();
    app.notify.toast(app.warp.listen && p ? `Hearing it warped to ${fmtBpm(p.bpm)} BPM · ${WARP_MODE_INFO[app.warp.mode].label}` : 'Hearing the original');
  }

  /** Back to how the warp starts: the full-mix method, the averaged tempo, the original playing. */
  reset(): void { this.update(defaultWarp()); }

  // ---------- the take heard in the Beats step ----------
  wanted(): boolean {
    const { app } = this;
    return app.step === 2 && app.warp.listen && !!this.plan();
  }

  current(): Take | null {
    const r = this.fresh();
    if (!r) return null;
    return (r.take ??= this.makeTake(r));
  }

  async prepare(): Promise<boolean> {
    try {
      return !!(await this.render());
    } catch (e) {
      console.error(e);
      this.update({ listen: false });
      this.app.notify.toast("Couldn't warp the audio to play it – loop a shorter part and try again.");
      return false;
    }
  }

  private makeTake(r: Render): Take {
    const { app } = this, { map, q0, bpm } = r.plan, a = map.src[0], b = map.src[map.src.length - 1], meter = app.doc.meter;
    return {
      buffer: bufferFrom(r.chans, app.audio!.sr),
      toTake: (t) => map.dstAt(clamp(t, a, b)),
      toSource: (t) => clamp(map.srcAt(t), 0, app.dur),
      clicks: (t0, t1, emit) => gridBeats(q0, bpm, meter, t0, t1, emit),
    };
  }

  // Switches what plays when it no longer matches what is wanted. A take made stale by an edit is
  // remade once the edits settle, so a run of nudges costs one render.
  private follow(): void {
    const pb = this.playback;
    // A render of another file is only memory now.
    if (this.last && this.last.inputs[0] !== this.app.audio) this.last = null;
    if (!pb.playing) return;
    const want = this.wanted(), take = want ? this.current() : null;
    if (pb.playingTake === take) return;
    if (this.restart) clearTimeout(this.restart);
    this.restart = null;
    if (!want || take) return pb.play(pb.now());
    const later = () => {
      this.restart = setTimeout(() => {
        this.restart = null;
        if (this.app.dragging) return later();
        if (pb.playing && this.wanted() && !this.current()) pb.play(pb.now());
      }, 350);
    };
    later();
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
    const map = app.tempoMap, out: number[] = [];
    for (let q = Math.ceil(map.timeToPos(0) * 4) / 4; ; q += 0.25) {
      const t = map.posToTime(q);
      if (t >= app.dur || out.length > 100000) break;
      if (t >= 0) out.push(t);
    }
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
      const len = a.chans[0].length, s0 = Math.max(0, Math.floor((p.map.src[0] - 0.5) * a.sr));
      const s1 = Math.min(len, Math.ceil((p.map.src[p.map.src.length - 1] + 0.5) * a.sr)), off = s0 / a.sr;
      const transients = mode === 'beats' ? this.transients().filter((t) => t >= off && t < s1 / a.sr).map((t) => t - off) : [];
      const chans = await this.analyzer.warp(
        { chans: a.chans.map((c) => c.subarray(s0, s1)), sr: a.sr, src: p.map.src.map((t) => t - off), dst: [...p.map.dst], n, mode, transients },
        (f) => app.notify.busy(label, 0.01 + 0.97 * f),
      );
      const r: Render = { inputs, plan: p, chans, take: null };
      // Kept unless a render of something newer landed first.
      if (!this.fresh()) this.last = r;
      return this.fresh() === r ? r : null;
    } finally {
      app.notify.idle();
    }
  }

  /** name_warped_120bpm.wav, or name_4bars_120bpm_warped.wav for a loop, as loops are named. */
  fileName(p: WarpPlan): string {
    const base = safeName(this.app.audio?.name || 'audio') || 'audio';
    if (!p.loop) return `${base}_warped_${fmtBpm(p.bpm)}bpm.wav`;
    const bars = Math.max(1, Math.round((p.outDur * p.bpm) / 60 / barQ(this.app.doc.meter)));
    return `${base}_${bars}bar${bars === 1 ? '' : 's'}_${fmtBpm(p.bpm)}bpm_warped.wav`;
  }

  async save(): Promise<void> {
    const { app } = this, a = app.audio;
    if (!a) return app.notify.toast('Open an audio file first.');
    this.beats.ensureDownbeat();
    if (!this.plan()) return app.notify.toast('Set bar 1 and at least a tempo in step 2 first.');
    try {
      const r = await this.render();
      if (!r) return app.notify.toast('The audio changed while it was warping – save again.');
      const p = r.plan, n = r.chans[0].length;
      // Channels, level and bit depth as the slicer has them; a warped file is one long sample.
      const out = renderSlice(r.chans, a.sr, 0, n / a.sr, { ...this.slicer.renderOptions(), fadeIn: 0, fadeOut: 0 });
      app.notify.busy('Writing the .wav', 0.95);
      const bytes = wavEncode(out.chans, a.sr, app.slicer.bits);
      app.notify.idle();
      const res = await saveFile(this.fileName(p), bytes as BlobPart, 'audio/wav');
      app.notify.toast(res.ok ? `Warped to ${fmtBpm(p.bpm)} BPM and saved.` : saveError(res.code, 'Too large for this viewer. Loop a shorter part, or use 16-bit mono.'));
    } catch (e) {
      console.error(e);
      app.notify.idle();
      app.notify.toast("Couldn't warp the audio – loop a shorter part and try again.");
    }
  }
}

const same = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((v, i) => v === b[i]);
