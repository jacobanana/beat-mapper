// Step 1: the transient markers. Detection settings, and adding, deleting and moving markers.
import type { Algo, Band } from '../../core/dsp/onset';
import { snapToZero } from '../../core/dsp/refine';
import { lowerBound } from '../../core/search';
import type { Marker } from '../../core/types';
import type { Analyzer } from '../../analysis/analyzer';
import { addManual, moveManual, removeCandidate, sortManual, withMarkers } from '../../state/project';
import { defaultDetection } from '../../state/settings';
import type { App } from '../app';
import type { Playback } from './playback';

const ALGO_NOTE: Record<Algo, string> = {
  flux: 'Spectral flux: new energy in any frequency bin',
  complex: 'Complex domain: new energy or a phase jump, for soft pitched notes too',
  gdelay: 'Group delay: every bin points at the instant its energy sits',
  energy: 'Energy rise: loudness jumps only',
};

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const manualId = (m: Marker) => +m.id.slice(1);

export class Markers {
  constructor(private readonly app: App, private readonly playback: Playback, private readonly analyzer: Analyzer) {}

  // ---------- detection settings ----------
  setSensitivity(sens: number): void { this.app.set('detection', { sens: clamp(sens, 0, 100) }); }
  setGap(ms: number): void { this.app.set('detection', { gap: ms }); }
  toggleOdf(): void { this.app.set('detection', { showOdf: !this.app.detection.showOdf }); }

  async setBand(band: Band): Promise<void> {
    this.app.set('detection', { band });
    await this.refreshCandidates();
  }

  async setAlgo(algo: Algo): Promise<void> {
    this.app.set('detection', { algo });
    this.app.notify.toast(ALGO_NOTE[algo]);
    await this.refreshCandidates();
  }

  /** Re-picks the candidates for the current band and algorithm. Deletions don't carry across. */
  async refreshCandidates(): Promise<void> {
    const { app } = this;
    if (!app.analysis) return;
    const { band, algo } = app.detection;
    const cands = await this.analyzer.candidates(band, algo);
    if (app.detection.band !== band || app.detection.algo !== algo) return; // changed again meanwhile
    app.cands = cands;
    app.edit((d) => withMarkers(d, { removed: [] }), false);
    app.bus.emit('candidates');
  }

  // ---------- editing ----------
  select(m: Marker | null, move = true): void {
    this.app.select(m ? { kind: 'marker', id: m.id } : null);
    if (m && move) { this.playback.seek(m.t); this.app.reveal(m.t); }
  }

  /** Tab / Shift+Tab: the next or previous transient after the playhead. */
  tab(dir: 1 | -1): void {
    const M = this.app.markers, t = this.app.transport.playhead;
    if (!M.length) return;
    let i: number;
    if (dir > 0) { i = lowerBound(M, t + 1e-4); if (i >= M.length) return this.app.notify.toast('No more transients'); }
    else { i = lowerBound(M, t - 1e-4) - 1; if (i < 0) return this.app.notify.toast('No earlier transients'); }
    this.select(M[i]);
  }

  /** Adds a marker at t, on the nearest zero crossing, unless one is already within 3 ms. */
  add(t: number): void {
    const { app } = this, a = app.audio;
    if (!a) return;
    t = snapToZero(a.x, a.sr, clamp(t, 0, app.dur));
    if (app.markers.some((m) => Math.abs(m.t - t) < 0.003)) return;
    let id = 0;
    app.edit((d) => { const [nd, nid] = addManual(d, t); id = nid; return nd; });
    app.select({ kind: 'marker', id: 'm' + id });
  }

  remove(m: Marker): void {
    this.app.edit((d) => (m.manual ? withMarkers(d, { manual: d.markers.manual.filter((k) => k.id !== manualId(m)) }) : removeCandidate(d, m.t)));
    this.app.select(null);
  }

  removeSelected(): void {
    const m = this.app.selectedMarker();
    if (m) this.remove(m);
    else this.app.notify.toast('Select a marker first.');
  }

  /** Discards every manual edit: placed markers go, deleted ones come back. */
  discardEdits(): void {
    if (!this.app.audio) return;
    this.app.edit((d) => withMarkers(d, { manual: [], removed: [] }));
  }

  /** Something in this step differs from how it starts: an edit, or a detection setting. */
  get changed(): boolean {
    const { app } = this, d = app.detection, d0 = defaultDetection(), m = app.doc.markers;
    return !!app.audio && (m.manual.length > 0 || m.removed.length > 0 || d.sens !== d0.sens || d.gap !== d0.gap || d.band !== d0.band || d.algo !== d0.algo);
  }

  /** Starts the step again: the edits go (one undo step brings them back) and detection is as it starts. */
  async reset(): Promise<void> {
    const { app } = this;
    if (!this.changed) return;
    this.discardEdits();
    const d0 = defaultDetection(), refresh = app.detection.band !== d0.band || app.detection.algo !== d0.algo;
    app.set('detection', { sens: d0.sens, gap: d0.gap, band: d0.band, algo: d0.algo });
    app.select(null);
    app.notify.toast('Transients reset: detection as it starts, markers as found. Undo brings your marker edits back.');
    if (refresh) await this.refreshCandidates();
  }

  /**
   * Turns a detected marker into a manual one at the same place, so it can be moved (the detected
   * one is deleted). Not recorded for undo: the caller has already checkpointed.
   */
  toManual(m: Marker): string {
    if (m.manual) return m.id;
    let id = 0;
    this.app.edit((d) => { const [nd, nid] = addManual(removeCandidate(d, m.t), m.t); id = nid; return nd; }, false);
    return 'm' + id;
  }

  /** Moves a manual marker while dragging (not recorded; the drag checkpointed at its start). */
  moveTo(id: string, t: number): void {
    this.app.edit((d) => moveManual(d, +id.slice(1), clamp(t, 0, this.app.dur)), false);
  }

  /** The end of a drag: the marker list settles. */
  settle(): void {
    this.app.edit(sortManual, false);
  }

  /** ← → with a marker selected: moves it by dt seconds. */
  nudge(m: Marker, dt: number): void {
    const { app } = this;
    app.checkpoint();
    const id = this.toManual(m);
    const cur = app.doc.markers.manual.find((k) => 'm' + k.id === id)!;
    const t = clamp(cur.t + dt, 0, app.dur);
    app.edit((d) => sortManual(moveManual(d, cur.id, t)), false);
    app.select({ kind: 'marker', id });
    this.playback.seek(t, true);
  }
}
