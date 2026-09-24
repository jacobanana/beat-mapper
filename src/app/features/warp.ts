// Step 3, Warp: the audio re-timed so that the tempo map becomes a straight grid at one tempo, heard
// here and saved as a .wav that drops into a DAW with no tempo map at all. The tempo map is made in
// Beats; here it is only read. What is warped and how is set here; rendering it is `WarpRender`'s.
import { fmtBpm, fmtTime, safeName } from '../../core/format';
import { renderSlice } from '../../core/slices/slices';
import { type Grid, type Meter, barQ, beatQ } from '../../core/tempo/meter';
import type { TimeRange } from '../../core/types';
import { averageBpm } from '../../core/warp/map';
import { type Alignment, placeWarpMarker, quantizeTransients, removeWarpMarker, warpMarkerAt } from '../../core/warp/markers';
import { WARP_MODE_INFO, type WarpMode } from '../../core/warp/modes';
import { saveError, saveFile } from '../../io/download';
import { wavEncode } from '../../io/formats/wav';
import type { ProjectDoc } from '../../state/project';
import { type WarpSettings, defaultBeats, defaultWarp, sliceRenderOptions } from '../../state/settings';
import { STEP } from '../../state/steps';
import type { App } from '../app';
import { stepRules } from '../steps';
import type { WarpPlan } from '../warp-out';
import type { Beats } from './beats';
import type { WarpRender } from './warp-render';

export type { WarpPlan } from '../warp-out';

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export class Warp {
  constructor(
    private readonly app: App,
    private readonly beats: Beats,
    private readonly rendered: WarpRender,
  ) {
    // While Quantize is on, a new grid or shuffle lines the transients up on it again; leaving the step
    // ends it, so a grid changed in Beats doesn't move them unseen.
    app.bus.on('beats', () => { if (this.quantizing && this.quantizing.grid !== app.grid) this.requantize(); });
    app.bus.on('step', () => { if (app.step !== STEP.warp) this.endQuantize(); });
  }

  update(patch: Partial<WarpSettings>): void { this.app.set('warp', patch); }

  /** What would be warped, and how, or null when there is no tempo map yet. */
  plan(): WarpPlan | null { return this.app.warpPlan; }

  setMode(mode: WarpMode): void {
    this.update({ mode });
    this.app.notify.toast(WARP_MODE_INFO[mode].label + ': ' + WARP_MODE_INFO[mode].desc);
  }

  /** Warped or the original: what Warp, Slice and Groove hear, cut, measure and export. */
  setListen(listen: boolean): void { this.update({ listen }); }

  /** W: the other one. Transients and Beats work on the original whatever it is set to. */
  toggleListen(): void {
    const { app } = this;
    this.setListen(!app.warp.listen);
    const what = app.warp.listen ? 'Warped: Warp, Slice and Groove use the audio on the grid' : 'Original: Warp, Slice and Groove use the audio as it is';
    app.notify.toast(!stepRules(app.step).hearsWarp ? what + '. Transients and Beats always use the original.' : what);
  }

  setRange(range: WarpSettings['range']): void {
    this.update({ range });
    if (range === 'loop' && !this.app.activeLoop) this.app.notify.toast('Switch the loop on to warp just the loop (drag in the top strip to draw one).');
  }

  /**
   * F: the grid tempo from the loop. A section that is played right sets the tempo, and the whole file
   * is warped to it. To the nearest BPM, since a straight grid is almost always wanted at a round one.
   */
  fromLoop(): void {
    const { app } = this, L = app.transport.loop;
    if (!app.hasMap) return app.notify.toast('Map the beats first (step 2).');
    if (!L || L.b - L.a < 0.05) return app.notify.toast('Loop the section to take the tempo from first (drag in the top strip).');
    const avg = averageBpm(app.tempoMap, L), bpm = Math.max(20, Math.min(400, Math.round(avg)));
    this.update({ bpm });
    app.notify.toast(`The loop averages ${fmtBpm(+avg.toFixed(2))} BPM · the grid is ${bpm} BPM`);
  }

  /** Something in this step differs from how it starts. */
  get changed(): boolean {
    const w = this.app.warp, w0 = defaultWarp();
    return !!this.app.audio && (w.mode !== w0.mode || w.bpm !== w0.bpm || w.range !== w0.range || w.quantize !== w0.quantize ||
      this.app.beats.shuffle !== defaultBeats().shuffle || this.app.doc.warpMarkers.length > 0);
  }

  /**
   * Back to how the step starts: the averaged tempo, the whole file, the full-mix method, heard warped,
   * no warp markers, a straight grid and quantize at full strength. The shuffle is the Beats grid's
   * too, but it is set here, so it goes back here as well.
   */
  reset(): void {
    if (!this.changed) return;
    this.quantizing = null;
    this.app.edit((d) => (d.warpMarkers.length ? { ...d, warpMarkers: [] } : d));
    this.beats.setShuffle(defaultBeats().shuffle);
    this.update(defaultWarp());
    this.app.notify.toast('Warp reset: the whole file at the tempo it averages. Undo brings the warp markers back.');
  }

  // ---------- warp markers: a transient lined up with the grid ----------
  private setMarkers(markers: ProjectDoc['warpMarkers']): void {
    this.app.edit((d) => ({ ...d, warpMarkers: markers }));
  }

  /**
   * Where the pointer over the audio at time `at` would put the transient at t: the grid line drawn
   * nearest there, or anywhere when `free`. Null if it would cross another warp marker.
   */
  private target(t: number, at: number, free: boolean): number | null {
    const { app } = this, pos = app.timeline.posOf(at);
    const q = free ? pos : app.grid.nearest(pos);
    return placeWarpMarker(app.doc.warpMarkers, t, q).ok ? q : null;
  }

  /** Starts dragging the transient (or warp marker) at t onto the grid. */
  grab(t: number): void {
    const { app } = this;
    app.warpDrag = { t, q: null, at: t };
    app.select({ kind: 'warp', t });
  }

  /** The dragged transient is over time `at`: it snaps to the grid line nearest there. */
  dragTo(at: number, free = false): void {
    const d = this.app.warpDrag;
    if (!d) return;
    this.app.warpDrag = { t: d.t, q: this.target(d.t, at, free), at };
    this.app.bus.emit('display');
  }

  /** Lets go: the transient is put on the grid line it was dropped on, as one undo step. */
  drop(): void {
    const { app } = this, d = app.warpDrag;
    if (!d) return;
    app.warpDrag = null;
    if (d.q == null) {
      app.bus.emit('display');
      return app.notify.toast("Can't put it there – it would cross another warp marker.");
    }
    this.put(d.t, d.q);
  }

  cancelDrag(): void {
    if (!this.app.warpDrag) return;
    this.app.warpDrag = null;
    this.app.bus.emit('display');
  }

  /** Double tap on a transient: onto the grid line nearest it. */
  snap(t: number): void {
    const { app } = this;
    if (!app.hasMap) return app.notify.toast('Map the beats first (step 2).');
    const q = this.target(t, t, false);
    if (q == null) return app.notify.toast("Can't line it up there – it would cross another warp marker.");
    this.put(t, q);
  }

  private put(t: number, q: number): void {
    const { app } = this, r = placeWarpMarker(app.doc.warpMarkers, t, q);
    if (!r.ok) return;
    this.setMarkers(r.markers);
    app.select({ kind: 'warp', t });
    app.notify.toast('Lined up on ' + posLabel(q, app.doc.meter));
  }

  /** Lets the transient at t move with the audio again. */
  remove(t: number): void {
    const out = removeWarpMarker(this.app.doc.warpMarkers, t);
    if (!out) return;
    this.setMarkers(out);
    this.app.select(null);
    this.app.notify.toast('Warp marker removed');
  }

  /** A warp marker holds the transient at t. */
  isMarker(t: number): boolean { return !!warpMarkerAt(this.app.doc.warpMarkers, t); }

  /** The warp marker selected, if any. */
  selected(): number | null {
    const s = this.app.sel;
    return s?.kind === 'warp' && this.isMarker(s.t) ? s.t : null;
  }

  removeSelected(): void {
    const t = this.selected();
    if (t == null) return this.app.notify.toast('Select a warp marker first.');
    this.remove(t);
  }

  // A quantize whose strength is still being set: what it started from, and the document it last made,
  // so each move of the slider quantizes again from the start as one undo step, and any other edit ends it.
  private quantizing: {
    base: ProjectDoc['warpMarkers'];
    map: Alignment;
    range: TimeRange;
    grid: Grid;
    doc: ProjectDoc;
    recorded: boolean;
  } | null = null;

  /**
   * Q: every transient of what is warped towards the grid line nearest it, as far as the strength
   * says. Returns whether there was anything to line up, so the strength can then be set.
   */
  quantize(): boolean {
    const { app } = this, p = this.plan();
    this.quantizing = null;
    if (!app.hasMap || !p) return this.say(app.hasMap ? 'Switch the loop on to warp just the loop.' : 'Map the beats first (step 2).');
    if (!app.markers.length) return this.say('No transients to line up. Raise the sensitivity in step 1.');
    const base = app.doc.warpMarkers, map = app.alignment, range = p.range;
    if (quantizeTransients(map, app.grid, app.markers.map((m) => m.t), range, base).length === base.length) return this.say('Every transient is already lined up.');
    this.quantizing = { base, map, range, grid: app.grid, doc: app.doc, recorded: false };
    const n = this.requantize(), pct = app.warp.quantize;
    app.notify.toast(n > 0 ? `${n} transients lined up on the grid${pct < 100 ? ` at ${pct} %` : ''} · Quantize again takes them back` : 'Strength 0 %: raise it to line the transients up.');
    return true;
  }

  private say(msg: string): false {
    this.app.notify.toast(msg);
    return false;
  }

  /** The quantize just made can still be changed: nothing has been edited since. */
  get quantizeOpen(): boolean { return this.quantizing?.doc === this.app.doc; }

  /** How far Quantize moves the transients, in percent; the quantize just made follows it. */
  setQuantizeStrength(pct: number): void {
    this.update({ quantize: clamp(Math.round(pct), 0, 100) });
    this.requantize();
  }

  /** The grid changed, or the strength: the quantize just made is made again. The number added, or -1 if it has ended. */
  requantize(): number {
    const { app } = this, q = this.quantizing;
    if (!q || !this.quantizeOpen) {
      this.quantizing = null;
      return -1;
    }
    q.grid = app.grid;
    const out = quantizeTransients(q.map, app.grid, app.markers.map((m) => m.t), q.range, q.base, app.warp.quantize / 100);
    if (!q.recorded) {
      if (out.length === q.base.length) return 0;
      app.checkpoint();
      q.recorded = true;
    }
    // Noted before the edit announces it, so whoever listens sees the quantize still open.
    const next = { ...app.doc, warpMarkers: out };
    q.doc = next;
    app.edit(() => next, false);
    return out.length - q.base.length;
  }

  /** The strength is set: the next change to the warp markers is a new edit. */
  endQuantize(): void {
    if (!this.quantizing) return;
    this.quantizing = null;
    this.app.bus.emit('warp');
  }

  /**
   * Quantize as a switch: on lines the transients up, off puts back the warp markers there were
   * before, as long as nothing has been edited since. The undo it takes leaves a redo to turn it on again.
   */
  toggleQuantize(): void {
    if (!this.quantizeOpen) {
      this.quantize();
      return this.app.bus.emit('warp');
    }
    const recorded = this.quantizing!.recorded;
    this.quantizing = null;
    if (recorded) this.app.undo();
    this.app.bus.emit('warp');
    this.app.notify.toast('Quantize off');
  }

  /** Every warp marker off: only the pins are warped onto the grid again. */
  clearMarkers(): void {
    const { app } = this;
    if (!app.doc.warpMarkers.length) return;
    this.setMarkers([]);
    app.select(null);
    app.notify.toast('Warp markers cleared · undo brings them back');
  }

  /** One line for the panel: what is warped, to what, and how far it is stretched. */
  summary(): string {
    const { app } = this, p = this.plan();
    if (!app.audio) return '';
    if (!app.hasMap) return 'Map the beats first (step 2): the warp puts every beat of the map on a straight grid.';
    if (!p) return 'Switch the loop on to warp just the loop.';
    const pct = (r: number) => Math.round(r * 100) + ' %', [lo, hi] = p.ratios;
    const what = p.loop ? 'The loop' : 'The file';
    const stretch = Math.abs(hi - lo) < 0.005 ? `stretched to ${pct(lo)}` : `stretched ${pct(lo)}–${pct(hi)}`;
    const n = app.doc.warpMarkers.length, lined = n ? ` · ${n} transient${n === 1 ? '' : 's'} lined up` : '';
    return `${what} averages ${fmtBpm(+p.avgBpm.toFixed(2))} BPM · warped to ${fmtBpm(p.bpm)} BPM, ${stretch} · ${fmtTime(p.srcDur)} → ${fmtTime(p.outDur)}${lined}`;
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
      const r = await this.rendered.render();
      if (!r) return app.notify.toast('The audio changed while it was warping – save again.');
      const p = r.plan, n = r.chans[0].length;
      // Channels, level and bit depth as the slicer has them; a warped file is one long sample.
      const out = renderSlice(r.chans, a.sr, 0, n / a.sr, { ...sliceRenderOptions(app.slicer), fadeIn: 0, fadeOut: 0 });
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

/** Position q as bar and beat, counting from 1: `bar 3, beat 2.5`. */
function posLabel(q: number, meter: Meter): string {
  const bq = barQ(meter), btq = beatQ(meter), bar = Math.floor(q / bq + 1e-9), beat = (q - bar * bq) / btq + 1;
  return `bar ${bar + 1}, beat ${+beat.toFixed(3)}`;
}

