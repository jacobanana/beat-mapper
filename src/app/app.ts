// The application state and the derived data everything else reads. Features (app/features/*) change
// it through the methods here; the UI listens for the topics they emit and redraws.
import type { Analysis } from '../core/dsp/onset';
import { detectMarkers, filterMarkers, sensToThr } from '../core/markers/detect';
import { type Slice, isExcluded, loopInfo, planSlices, sliceKey } from '../core/slices/slices';
import { Grid, barQ } from '../core/tempo/meter';
import { type Bar, TempoMap } from '../core/tempo/tempo-map';
import type { Anchor, Candidate, Marker, TimeRange } from '../core/types';
import type { Step } from '../io/session';
import { Emitter } from '../state/emitter';
import { History } from '../state/history';
import { memo } from '../state/memo';
import { type ProjectDoc, emptyDoc } from '../state/project';
import {
  type BeatSettings, type DetectionSettings, type ExportSettings, type SlicerSettings, type TransportState,
  defaultBeats, defaultDetection, defaultExport, defaultSlicer, defaultTransport,
} from '../state/settings';
import { Viewport } from '../state/viewport';
import type { AudioAsset } from './audio-asset';

/** What changed. Listeners subscribe to the topics they display. */
export type Topic =
  | 'audio' | 'doc' | 'candidates' | 'detection' | 'beats' | 'export' | 'slicer' | 'slices'
  | 'transport' | 'playhead' | 'view' | 'step' | 'selection' | 'hover' | 'display';

export type Selection = { kind: 'marker'; id: string } | { kind: 'anchor'; q: number } | null;
/** What the pointer is over: a marker, a pin, or a grid line that could become a pin. */
export type Hover = Selection | { kind: 'grid'; q: number };

export interface SliceView extends Slice {
  /** Dropped from the export. */
  readonly off: boolean;
}

/** Messages for the user. The UI decides how to show them. */
export interface Notifier {
  toast(msg: string): void;
  busy(text: string, fraction: number): void;
  idle(): void;
}

type Settings = { detection: DetectionSettings; beats: BeatSettings; export: ExportSettings; slicer: SlicerSettings; transport: TransportState };

export class App {
  readonly bus = new Emitter<Topic>();
  readonly history = new History<ProjectDoc>(120);
  readonly view = new Viewport();

  audio: AudioAsset | null = null;
  analysis: Analysis | null = null;
  /** Candidate transients for the current band and algorithm. */
  cands: readonly Candidate[] = [];
  doc: ProjectDoc = emptyDoc();

  detection = defaultDetection();
  beats = defaultBeats();
  exportSettings = defaultExport();
  slicer = defaultSlicer();
  transport = defaultTransport();

  step: Step = 1;
  sel: Selection = null;
  hover: Hover = null;
  /** Waveform height multiplier. */
  amp = 1;
  /** Start times of the slices dropped from the export. */
  excluded: number[] = [];
  /** Start time of the selected slice. */
  sliceSel: number | null = null;
  /** True while a pointer drag is editing something; autosave waits for it to finish. */
  dragging = false;
  busy = false;

  constructor(readonly notify: Notifier) {}

  // ---------- derived data ----------
  private readonly _map = memo((t: ProjectDoc['tempo']) => new TempoMap(t.anchors, t.baseBpm));
  get tempoMap(): TempoMap { return this._map(this.doc.tempo); }

  private readonly _grid = memo((m: ProjectDoc['meter'], g: BeatSettings['grid']) => new Grid(m, g));
  get grid(): Grid { return this._grid(this.doc.meter, this.beats.grid); }

  private readonly _detected = memo((c: readonly Candidate[], sens: number, gap: number) => detectMarkers(c, sensToThr(sens), gap / 1000));
  private readonly _markers = memo((c: readonly Candidate[], det: number[], removed: readonly number[], manual: ProjectDoc['markers']['manual']) => {
    const rm = new Set(removed), idx = new Set<number>();
    if (rm.size) det.forEach((i) => { if (rm.has(c[i].t)) idx.add(i); });
    return filterMarkers(c, det, idx, manual);
  });
  /** The markers shown: detected at the current settings, minus deleted, plus manual. Sorted by time. */
  get markers(): readonly Marker[] {
    const det = this._detected(this.cands, this.detection.sens, this.detection.gap);
    return this._markers(this.cands, det, this.doc.markers.removed, this.doc.markers.manual);
  }

  private readonly _bars = memo((map: TempoMap, meter: ProjectDoc['meter'], dur: number) => map.bars(meter, dur));
  get bars(): readonly Bar[] { return this._bars(this.tempoMap, this.doc.meter, this.dur); }

  private readonly _slices = memo((markers: readonly Marker[], o: SlicerSettings, range: TimeRange, dur: number, excluded: number[]) => {
    const plan = planSlices(markers.map((m) => m.t), { dur, from: range.a, to: range.b, minLen: o.min / 1000, mode: o.mode, len: o.len / 1000, tail: o.tail / 1000 });
    const ex = new Set(excluded.map(sliceKey));
    return plan.map((sl): SliceView => ({ ...sl, off: isExcluded(ex, sl.t0) }));
  });
  private readonly _range = memo((loop: TimeRange | null, on: boolean, dur: number): TimeRange => (on && loop && loop.b - loop.a > 0.01 ? loop : { a: 0, b: dur }));
  /** With the loop on, only what is inside it is sliced – and so only that is exported. */
  get sliceRange(): TimeRange { return this._range(this.transport.loop, this.transport.loopOn, this.dur); }
  get slices(): readonly SliceView[] {
    if (!this.audio) return [];
    return this._slices(this.markers, this.slicer, this.sliceRange, this.dur, this.excluded);
  }
  /** Index of the selected slice: the one starting within 50 ms of where the selection was. */
  get sliceIndex(): number | null {
    if (this.sliceSel == null) return null;
    let bi = -1, bd = Infinity;
    for (const sl of this.slices) { const d = Math.abs(sl.t0 - this.sliceSel); if (d < bd) { bd = d; bi = sl.i; } }
    return bd < 0.05 ? bi : null;
  }

  get dur(): number { return this.audio?.dur ?? 0; }
  get hasMap(): boolean { return this.doc.tempo.anchors.length > 0; }

  /** The loop when it is switched on and not empty. */
  get activeLoop(): TimeRange | null {
    const L = this.transport.loop;
    return this.transport.loopOn && L && L.b - L.a > 0.01 ? L : null;
  }

  /** The active loop as music: its nearest whole bar count and the tempo that implies. */
  get loopInfo() {
    const L = this.activeLoop;
    if (!L) return null;
    const map = this.tempoMap, q = map.isEmpty ? ((L.b - L.a) * map.baseBpm) / 60 : Math.abs(map.timeToPos(L.b) - map.timeToPos(L.a));
    return loopInfo(L, q, barQ(this.doc.meter));
  }

  selectedMarker(): Marker | null {
    const s = this.sel;
    return s && s.kind === 'marker' ? (this.markers.find((m) => m.id === s.id) ?? null) : null;
  }

  selectedAnchor(): Anchor | null {
    const s = this.sel;
    return s && s.kind === 'anchor' ? (this.doc.tempo.anchors.find((a) => a.q === s.q) ?? null) : null;
  }

  // ---------- changes ----------
  /** Applies an edit to the document, recorded for undo unless `record` is false. */
  edit(fn: (d: ProjectDoc) => ProjectDoc, record = true): void {
    const next = fn(this.doc);
    if (next === this.doc) return;
    if (record) this.history.record(this.doc);
    this.doc = next;
    this.bus.emit('doc');
  }

  /** Records the current document for undo without changing it (the start of a drag). */
  checkpoint(): void {
    this.history.record(this.doc);
  }

  undo(): boolean { return this.restore(this.history.undo(this.doc)); }
  redo(): boolean { return this.restore(this.history.redo(this.doc)); }
  private restore(d: ProjectDoc | null): boolean {
    if (!d) return false;
    this.doc = d;
    this.sel = null;
    this.bus.emit('doc', 'selection');
    return true;
  }

  /** Updates one group of settings and tells whoever shows it. */
  set<K extends keyof Settings>(group: K, patch: Partial<Settings[K]>): void {
    const key = group === 'export' ? 'exportSettings' : group;
    (this as unknown as Record<string, object>)[key] = { ...(this as unknown as Record<string, object>)[key], ...patch };
    this.bus.emit(group as Topic);
  }

  select(sel: Selection): void {
    this.sel = sel;
    this.bus.emit('selection');
  }

  setStep(step: Step): void {
    this.step = step;
    this.sel = null;
    this.hover = null;
    this.bus.emit('step', 'selection');
  }

  /** Moves both the playhead and the start point. */
  setPlayhead(t: number, alsoStart = true): void {
    const tt = Math.max(0, Math.min(this.dur, t));
    this.transport.playhead = tt;
    if (alsoStart) this.transport.start = tt;
    this.bus.emit('playhead');
  }

  setView(t0: number, t1: number): void {
    this.view.set(t0, t1);
    this.bus.emit('view');
  }

  reveal(t: number): void {
    this.view.reveal(t);
    this.bus.emit('view');
  }
}
