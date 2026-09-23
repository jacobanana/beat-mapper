// Step 2: the tempo map. Bar 1, pins, auto-mapping, deriving from a loop, meter and tempo.
import * as edit from '../../core/beats/edit';
import { GRID_STEPS, type GridDivision } from '../../core/tempo/meter';
import type { Anchor } from '../../core/types';
import { type ProjectDoc, withAnchors } from '../../state/project';
import { SNAP_MODES, type SnapMode } from '../../state/settings';
import type { App } from '../app';
import type { Playback } from './playback';

const SNAP_NOTE: Record<SnapMode, string> = {
  markers: 'Snapping to transients (hold Alt to bypass)',
  grid: 'Snapping to the grid at the resolution set here – pins stay free, they are what makes the grid',
  off: 'Snapping off (hold Alt to reach for transients)',
};
export const GRID_LABELS: Record<GridDivision, string> = {
  bar: 'Bar', '2': '1/2', '4': '1/4', '8': '1/8', '16': '1/16', '32': '1/32', '4t': '1/4T', '8t': '1/8T', '16t': '1/16T',
};

export class Beats {
  private readonly taps = new edit.TapTempo();

  constructor(private readonly app: App, private readonly playback: Playback) {}

  private setAnchors(anchors: readonly Anchor[], record = true, baseBpm?: number): void {
    this.app.edit((d) => withAnchors(d, anchors, baseBpm ?? d.tempo.baseBpm), record);
  }

  private selectPin(q: number): void { this.app.select({ kind: 'anchor', q }); }

  /** Bar 1 on the first transient, if nothing is pinned yet. Not an undo step: it's a default. */
  ensureDownbeat(): void {
    const anchors = edit.ensureDownbeat(this.app.doc.tempo.anchors, this.app.markers);
    if (!anchors) return;
    this.setAnchors(anchors, false);
    this.app.notify.toast('Bar 1 set on the first transient');
  }

  /** D: bar 1 starts at T. */
  setDownbeat(T: number): void {
    if (!this.app.audio) return;
    this.setAnchors(edit.setDownbeat(this.app.tempoMap, this.app.grid, T));
    this.selectPin(0);
  }

  /** B: pins the nearest grid line (or position q) to T. */
  pinAt(T: number, q?: number): Anchor | null {
    const { app } = this;
    if (!app.audio) return null;
    const r = edit.pinAt(app.tempoMap, app.grid, T, q);
    if (!r.ok) {
      app.notify.toast(r.reason === 'before-bar-1' ? 'That is before bar 1. Press D to start bar 1 here instead.' : "Can't pin there – it would cross a neighbouring pin.");
      return null;
    }
    this.setAnchors(r.anchors);
    this.selectPin(r.pinned.q);
    return r.pinned;
  }

  unpin(a: Anchor): void {
    const anchors = edit.unpin(this.app.tempoMap, a.q);
    if (!anchors) return this.app.notify.toast('Bar 1 stays pinned. Move it with D or by dragging.');
    this.setAnchors(anchors);
    this.app.select(null);
  }

  unpinSelected(): void {
    const a = this.app.selectedAnchor();
    if (a) this.unpin(a);
    else this.app.notify.toast('Select a pin first.');
  }

  clearPins(): void {
    if (this.app.doc.tempo.anchors.length < 2) return;
    this.setAnchors(edit.clearPins(this.app.tempoMap));
  }

  /** M: follows the beat from bar 1 and the user's pins. */
  autoMap(): void {
    const { app } = this;
    if (!app.audio) return;
    this.ensureDownbeat();
    if (!app.markers.length) return app.notify.toast('No transients to map to. Raise the sensitivity in step 1.');
    this.setAnchors(edit.autoMapFromPins(app.tempoMap, app.markers, app.doc.meter, app.beats, app.dur));
    app.select(null);
    app.notify.toast(`${app.doc.tempo.anchors.length} pins`);
  }

  /** F: keeps the loop, rebuilds the rest of the map around it. */
  deriveFromLoop(): void {
    const { app } = this, L = app.transport.loop;
    if (!app.audio) return;
    if (!L || L.b - L.a < 0.05) return app.notify.toast('Draw a loop around the part that is right first (drag in the top ruler).');
    if (!app.markers.length) return app.notify.toast('No transients to follow. Raise the sensitivity in step 1.');
    const r = edit.deriveFromLoop(app.tempoMap, app.markers, L, app.doc.meter, app.beats, app.dur, app.beats.loopBars ?? undefined);
    this.setAnchors(r.anchors, true, r.baseBpm);
    app.select(null);
    const how = r.how.kind === 'loop' ? `loop taken as ${r.how.bars} bar${r.how.bars > 1 ? 's' : ''}` : `${r.how.count} pins in the loop kept`;
    app.notify.toast(`${r.bpm.toFixed(2)} BPM · ${how} · ${r.anchors.length} pins`);
  }

  /** ÷2 / ×2 */
  scaleTempo(f: number): void {
    const t = this.app.doc.tempo, r = edit.scaleTempo(t.anchors, t.baseBpm, f);
    this.setAnchors(r.anchors, true, r.baseBpm);
  }

  tap(): void {
    const r = this.taps.tap(performance.now(), this.app.doc.meter);
    if (!r) return this.app.notify.toast('Keep tapping…');
    if (r.first) this.app.checkpoint();
    this.app.edit((d) => ({ ...d, tempo: { ...d.tempo, baseBpm: r.bpm } }), false);
    this.app.notify.toast(`Starting tempo ${r.bpm} BPM`);
  }

  setBaseBpm(bpm: number): void {
    this.app.edit((d) => ({ ...d, tempo: { ...d.tempo, baseBpm: edit.clampBpm(bpm || 120) } }));
    if (this.app.doc.tempo.anchors.length > 1) this.app.notify.toast('Starting tempo applies after the last pin and when auto-mapping.');
  }

  setMeter(m: Partial<ProjectDoc['meter']>): void {
    this.app.edit((d) => ({ ...d, meter: { ...d.meter, ...m } }));
  }

  // ---------- dragging and nudging pins ----------
  /** Starts dragging pin q, or a grid line at q that becomes a pin. Returns the pin's q. */
  beginDrag(q: number, fromGrid: boolean): number {
    const { app } = this;
    app.checkpoint();
    const map = app.tempoMap;
    const anchors = fromGrid
      ? [...map.anchors, { q, t: map.posToTime(q), manual: true }]
      : map.anchors.map((a) => (a.q === q ? { ...a, manual: true } : a));
    this.setAnchors(anchors, false);
    this.selectPin(q);
    return q;
  }

  dragTo(q: number, t: number): void {
    this.setAnchors(edit.moveAnchor(this.app.tempoMap, q, t, this.app.dur), false);
  }

  /** ← → with a pin selected. */
  nudge(a: Anchor, dt: number): void {
    const { app } = this;
    this.setAnchors(edit.moveAnchor(app.tempoMap, a.q, a.t + dt, app.dur));
    const moved = app.doc.tempo.anchors.find((k) => k.q === a.q);
    if (moved) this.playback.seek(moved.t, true);
  }

  // ---------- grid and magnet ----------
  setGrid(grid: GridDivision): void { this.app.set('beats', { grid }); }

  cycleGrid(dir: 1 | -1): void {
    const i = GRID_STEPS.indexOf(this.app.beats.grid);
    const ni = Math.max(0, Math.min(GRID_STEPS.length - 1, (i < 0 ? 4 : i) + dir));
    this.setGrid(GRID_STEPS[ni]);
    this.app.notify.toast('Grid ' + GRID_LABELS[GRID_STEPS[ni]]);
  }

  setSnap(to: SnapMode, quiet = false): void {
    this.app.set('beats', { snapTo: to });
    if (!quiet) this.app.notify.toast(SNAP_NOTE[to]);
  }

  cycleSnap(dir: 1 | -1): void {
    const i = SNAP_MODES.indexOf(this.app.beats.snapTo);
    this.setSnap(SNAP_MODES[(i + dir + SNAP_MODES.length) % SNAP_MODES.length]);
  }
}
