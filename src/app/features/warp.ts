// Step 3, Warp: the audio re-timed so that the tempo map becomes a straight grid at one tempo, heard
// here and saved as a .wav that drops into a DAW with no tempo map at all. The tempo map is made in
// Beats; here it is only read. What is warped and how is set here; rendering it is `WarpRender`'s.
import { fmtBpm, fmtTime, safeName } from '../../core/format';
import { renderSlice } from '../../core/slices/slices';
import { type Meter, barQ, beatQ } from '../../core/tempo/meter';
import { averageBpm } from '../../core/warp/map';
import { placeWarpMarker, removeWarpMarker, warpMarkerAt } from '../../core/warp/markers';
import { WARP_MODE_INFO, type WarpMode } from '../../core/warp/modes';
import { saveError, saveFile } from '../../io/download';
import { wavFile } from '../../io/formats/wav';
import type { ProjectDoc } from '../../state/project';
import { type WarpSettings, defaultBeats, defaultWarp, sliceRenderOptions, wavOptions } from '../../state/settings';
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
  ) {}

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

  /** Drums mode: fill the gaps left where a hit is moved away from the next, or leave them silent. */
  setFill(fill: boolean): void {
    const { app } = this;
    this.update({ fill });
    if (app.warp.mode !== 'beats') app.notify.toast('Filling the gaps is for Drums mode, which cuts instead of stretching: choose Drums under Warp.');
    else app.notify.toast(fill ? 'Gaps filled: each hit rings on into the next' : 'Gaps left silent');
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
    return !!this.app.audio && (w.mode !== w0.mode || w.bpm !== w0.bpm || w.range !== w0.range || w.quantize !== w0.quantize || w.fill !== w0.fill ||
      this.app.beats.shuffle !== defaultBeats().shuffle || this.app.doc.warpMarkers.length > 0);
  }

  /**
   * Back to how the step starts: the averaged tempo, the whole file, the full-mix method, heard warped,
   * no warp markers, a straight grid, no quantize and Drums mode's gaps left silent. The shuffle is the Beats grid's
   * too, but it is set here, so it goes back here as well.
   */
  reset(): void {
    if (!this.changed) return;
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

  /**
   * How far every transient of what is warped moves to the grid line nearest it, in percent: 0 leaves
   * them where they are, 100 puts them on it. The warp follows at once, and what plays once it settles.
   */
  setQuantizeStrength(pct: number): void {
    this.update({ quantize: clamp(Math.round(pct), 0, 100) });
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
    const n = app.doc.warpMarkers.length, q = app.warp.quantize;
    const lined = (q ? ` · quantized ${q} %` : '') + (n ? ` · ${n} transient${n === 1 ? '' : 's'} lined up by hand` : '');
    // Drums mode moves the hits rather than stretching anything, so what it leaves is gaps.
    const cuts = p.cuts;
    if (cuts) {
      const gaps = cuts.gaps(), longest = gaps.reduce((m, [a, b]) => Math.max(m, b - a), 0);
      const holes = gaps.length ? ` · ${gaps.length} gap${gaps.length === 1 ? '' : 's'}, longest ${Math.round(longest * 1000)} ms${app.warp.fill ? ', filled' : ''}` : ' · no gaps';
      return `${what} averages ${fmtBpm(+p.avgBpm.toFixed(2))} BPM · warped to ${fmtBpm(p.bpm)} BPM, cut at ${cuts.pieces.length} transients · ${fmtTime(p.srcDur)} → ${fmtTime(p.outDur)}${holes}${lined}`;
    }
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
      // Channels, level, depth and rate as the slicer has them; a warped file is one long sample.
      const out = renderSlice(r.chans, a.sr, 0, n / a.sr, { ...sliceRenderOptions(app.slicer), fadeIn: 0, fadeOut: 0 });
      app.notify.busy('Writing the .wav', 0.95);
      const bytes = wavFile(out.chans, a.sr, wavOptions(app.slicer));
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

