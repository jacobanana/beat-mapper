// The application state and the derived data everything else reads. Features (app/features/*) change
// it through the methods here; the UI listens for the topics they emit and redraws.
import type { Analysis } from '../core/dsp/onset';
import type { DrumAnalysis } from '../core/drums/detect';
import { type EditedHit, type HitEdits, applyHitEdits } from '../core/drums/edit';
import { selectHits } from '../core/drums/select';
import type { DrumHit, PerVoice, Voice } from '../core/drums/voices';
import { type Groove, type VoiceNote, analyseGroove, transcribe } from '../core/groove/pocket';
import { detectMarkers, filterMarkers, sensToThr } from '../core/markers/detect';
import { type HeardNote, type NoteEdits, heardNotes, selectNotes } from '../core/notes/select';
import type { Note, NoteAnalysis } from '../core/notes/types';
import { type Slice, isExcluded, loopInfo, planSlices, sliceKey } from '../core/slices/slices';
import { Grid, barQ } from '../core/tempo/meter';
import { type Bar, TempoMap, eachStep } from '../core/tempo/tempo-map';
import type { Anchor, Candidate, Marker, TimeRange } from '../core/types';
import { planCuts } from '../core/warp/beats';
import { averageBpm, planWarp, warpRange } from '../core/warp/map';
import type { WarpMode } from '../core/warp/modes';
import { Timeline } from '../core/timeline';
import { Alignment, type WarpMarker, quantizeTransients } from '../core/warp/markers';
import { Emitter } from '../state/emitter';
import { History } from '../state/history';
import { memo } from '../state/memo';
import { type ProjectDoc, emptyDoc } from '../state/project';
import {
  type BeatSettings, type DetectionSettings, type ExportSettings, type GrooveSettings, type MixSettings, type MuteSettings, type NoteSettings, type SlicerSettings, type TransportState,
  type WarpSettings, defaultBeats, defaultDetection, defaultExport, defaultGroove, defaultMix, defaultMute, defaultNotes, defaultSlicer, defaultTransport, defaultWarp,
} from '../state/settings';
import { type Step, STEP } from '../state/steps';
import { Viewport } from '../state/viewport';
import type { AudioAsset } from './audio-asset';
import { stepRules } from './steps';
import { type WarpOut, type WarpPlan, warpOut } from './warp-out';

export type { WarpOut, WarpPlan } from './warp-out';

/** What changed. Listeners subscribe to the topics they display. */
export type Topic =
  | 'audio' | 'doc' | 'candidates' | 'detection' | 'beats' | 'export' | 'slicer' | 'slices'
  | 'warp' | 'transport' | 'playhead' | 'view' | 'step' | 'selection' | 'hover' | 'display' | 'drums' | 'groove' | 'mix' | 'mute'
  /** The notes found in the audio (`transcript`), and the Notes step's settings (`notes`). */
  | 'transcript' | 'notes'
  /**
   * Derived: what is heard changed (the warp or the original, and which warp), and with it the
   * timeline, the slices and the pocket. Emitted by the App itself after whichever topic caused it, so
   * a view of anything placed by the warp listens to this one topic rather than to all its causes.
   */
  | 'heard';

export type Selection =
  | { kind: 'marker'; id: string } | { kind: 'anchor'; q: number } | { kind: 'hit'; voice: Voice; t: number }
  /** In the Warp step: a transient, or the warp marker on it, by its time. */
  | { kind: 'warp'; t: number }
  /** In the Notes step: a found note, by its pitch and start. */
  | { kind: 'note'; pitch: number; t: number }
  | null;
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

type Settings = {
  detection: DetectionSettings; beats: BeatSettings; export: ExportSettings; slicer: SlicerSettings; warp: WarpSettings; transport: TransportState; groove: GrooveSettings;
  notes: NoteSettings; mix: MixSettings; mute: MuteSettings;
};

/** A loop shorter than this is no loop: nothing plays, is warped or is sliced inside it. */
export const MIN_LOOP = 0.01;
/** The loop, when there is one long enough to be one. */
export const usableLoop = (L: TimeRange | null): TimeRange | null => (L && L.b - L.a > MIN_LOOP ? L : null);

export class App {
  readonly bus = new Emitter<Topic>();
  readonly history = new History<ProjectDoc>(120);
  readonly view = new Viewport();

  audio: AudioAsset | null = null;
  analysis: Analysis | null = null;
  /** Candidate transients for the current band and algorithm. */
  cands: readonly Candidate[] = [];
  /** Kick, snare and hat hits, found the first time the Groove step opens. */
  drums: DrumAnalysis | null = null;
  /** The notes in the audio, found the first time the Notes step opens, as a line or as chords. */
  transcript: NoteAnalysis | null = null;
  doc: ProjectDoc = emptyDoc();
  /** The tempo the audio was opened at, before any tapping or typing: where resetting Beats goes back to. */
  startBpm = 120;

  detection = defaultDetection();
  beats = defaultBeats();
  exportSettings = defaultExport();
  slicer = defaultSlicer();
  warp = defaultWarp();
  transport = defaultTransport();
  groove = defaultGroove();
  notes = defaultNotes();
  /** The mixer: a preference of this device, kept out of sessions. */
  mix = defaultMix();
  /** Muted channels: for this visit only, so the audio is never silent on arrival. */
  mute = defaultMute();

  step: Step = STEP.transients;
  sel: Selection = null;
  hover: Hover = null;
  /** Waveform height multiplier. */
  amp = 1;
  /** Start times of the slices dropped from the export. */
  excluded: number[] = [];
  /** Start time of the selected slice. */
  sliceSel: number | null = null;
  /**
   * A transient being dragged onto the grid in the Warp step: its time, and the position it would be
   * put on if let go now (null while it is off the grid, or would cross another warp marker).
   */
  warpDrag: { t: number; q: number | null; at: number } | null = null;
  /**
   * Set by Playback while something plays: the warp playing (a take made before an edit plays on
   * until the next is ready), or null for the original. Undefined while nothing plays.
   */
  playing: { out: WarpOut | null } | undefined = undefined;
  /** True while a pointer drag is editing something; autosave waits for it to finish. */
  dragging = false;
  busy = false;

  constructor(readonly notify: Notifier) {
    // 'heard' follows whatever changed what is heard, so nobody has to list its causes.
    let out: WarpOut | null = null, tl: Timeline | null = null;
    this.bus.on('*', (topic) => {
      if (topic === 'heard') return;
      const o = this.warpOut, t = this.timeline;
      if (o === out && t === tl) return;
      out = o;
      tl = t;
      this.bus.emit('heard');
    });
  }

  // ---------- derived data ----------
  private readonly _map = memo((t: ProjectDoc['tempo']) => new TempoMap(t.anchors, t.baseBpm));
  get tempoMap(): TempoMap { return this._map(this.doc.tempo); }

  private readonly _grid = memo((m: ProjectDoc['meter'], g: BeatSettings['grid'], sh: number) => new Grid(m, g, sh / 100));
  get grid(): Grid { return this._grid(this.doc.meter, this.beats.grid, this.beats.shuffle); }

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
  private readonly _range = memo((loop: TimeRange | null, dur: number): TimeRange => loop ?? { a: 0, b: dur });
  /** With the loop on, only what is inside it is sliced – and so only that is exported. */
  get sliceRange(): TimeRange { return this._range(this.activeLoop, this.dur); }
  private readonly _cutRange = memo((r: TimeRange, out: WarpOut | null): TimeRange =>
    (out ? { a: Math.max(r.a, out.range.a), b: Math.min(r.b, out.range.b) } : r));
  /** Slices are cut at the transients, from what is heard: only the part the warp makes when it is. */
  get slices(): readonly SliceView[] {
    if (!this.audio) return [];
    return this._slices(this.markers, this.slicer, this._cutRange(this.sliceRange, this.warpOut), this.dur, this.excluded);
  }
  /** Index of the selected slice: the one starting within 50 ms of where the selection was. */
  get sliceIndex(): number | null {
    if (this.sliceSel == null) return null;
    let bi = -1, bd = Infinity;
    for (const sl of this.slices) { const d = Math.abs(sl.t0 - this.sliceSel); if (d < bd) { bd = d; bi = sl.i; } }
    return bd < 0.05 ? bi : null;
  }

  private readonly _selected = memo((d: DrumAnalysis | null, sens: GrooveSettings['sens']) => (d ? selectHits(d.hits, sens) : null));
  /** The drum hits the sensitivities let through, before any edits by hand. */
  get detectedHits(): PerVoice<DrumHit[]> | null { return this._selected(this.drums, this.groove.sens); }

  private readonly _drumHits = memo((sel: PerVoice<DrumHit[]> | null, e: HitEdits) => (sel ? applyHitEdits(sel, e) : null));
  /** The drum hits the sensitivities let through, with the ones added, moved and deleted by hand. */
  get drumHits(): PerVoice<EditedHit[]> | null { return this._drumHits(this.detectedHits, this.doc.drums); }

  private readonly _drumNotes = memo((hits: PerVoice<EditedHit[]> | null) => (hits ? transcribe(hits) : []));
  /**
   * The drum hits as notes over the whole take, at their times in the original, sorted by time: what the
   * synth kit plays. The warp is the only quantize, so it plays them where what is heard has them.
   */
  get drumNotes(): readonly VoiceNote[] { return this._drumNotes(this.drumHits); }

  private readonly _pickedNotes = memo((a: NoteAnalysis | null, sens: number, e: NoteEdits) => (a ? selectNotes(a.notes, sens, e) : []));
  /** The notes the sensitivity lets through, minus the ones deleted, at their times in the original. */
  get pickedNotes(): readonly Note[] { return this._pickedNotes(this.transcript, this.notes.sens, this.doc.notes); }

  private readonly _heardNotes = memo((n: readonly Note[], legato: boolean) => heardNotes(n, legato));
  /**
   * The notes as the synth plays them and the MIDI holds them: with velocities, and held to the next
   * note with Legato on. Times in the original; the warp places them, as it does the drums.
   */
  get heardNotes(): readonly HeardNote[] { return this._heardNotes(this.pickedNotes, this.notes.legato); }

  // Always against the grid: the tempo map the user set is the beat the drums are heard against. When
  // the warp is heard, that grid is its straight one and the hits are where it puts them, quantized or
  // not: the pocket is the pocket of what is heard.
  private readonly _groove = memo((hits: PerVoice<EditedHit[]> | null, map: TempoMap, meter: ProjectDoc['meter'], grid: GrooveSettings['grid'], range: TimeRange, out: WarpOut | null) => {
    if (!hits || map.isEmpty) return null;
    if (!out) return analyseGroove(hits, { map, meter, grid, ref: 'grid', range });
    const r = this._cutRange(range, out);
    return analyseGroove(hits, { map: out.map, meter, grid, ref: 'grid', range: { a: out.at(r.a), b: out.at(r.b) }, at: out.at });
  });
  /** Where each voice sits against the grid, inside the loop when it is on. */
  get pocket(): Groove | null {
    return this._groove(this.drumHits, this.tempoMap, this.doc.meter, this.groove.grid, this.sliceRange, this.warpOut);
  }

  // Quantize is the strength, not an edit: every transient of what is warped goes that part of the way
  // to the grid line nearest it, on the pins with the warp markers placed by hand laid over. So the
  // strength, the grid and the shuffle move it as they move, and the warp and its render follow.
  private readonly _quantized = memo((map: TempoMap, manual: readonly WarpMarker[], grid: Grid, markers: readonly Marker[], range: TimeRange, strength: number) =>
    (strength > 0 ? quantizeTransients(Alignment.of(map, manual), grid, markers.map((m) => m.t), range, manual, strength / 100) : manual));
  /**
   * Every warp marker the warp follows: those placed by hand (in the document), and the transients
   * Quantize lines up at its strength.
   */
  get warpMarkers(): readonly WarpMarker[] {
    const loop = this.warp.range === 'loop' ? this.activeLoop : null;
    return this._quantized(this.tempoMap, this.doc.warpMarkers, this.grid, this.markers, this._warpedRange(loop, this.dur), this.warp.quantize);
  }
  private readonly _warpedRange = memo((loop: TimeRange | null, dur: number): TimeRange => loop ?? { a: 0, b: dur });

  private readonly _alignment = memo((map: TempoMap, wm: readonly WarpMarker[]) => Alignment.of(map, wm));
  /** Where the warp puts each moment of the audio: the pins with the warp markers laid over. Not a tempo. */
  get alignment(): Alignment { return this._alignment(this.tempoMap, this.warpMarkers); }

  // The tempo is the tempo map's: warp markers line hits up inside it, so quantizing, its strength or
  // the shuffle never change the tempo shown or the grid it is warped to.
  private readonly _warp = memo((map: Alignment, tempo: TempoMap, meter: ProjectDoc['meter'], dur: number, lead: ExportSettings['lead'], loop: TimeRange | null, gridBpm: number | null): WarpPlan | null => {
    if (map.isEmpty) return null;
    const r = warpRange(map, meter, dur, { lead, loop });
    if (!(r.b - r.a > MIN_LOOP)) return null;
    const avgBpm = averageBpm(tempo, r), bpm = gridBpm ?? Math.round(avgBpm);
    if (!(bpm > 0)) return null;
    const w = planWarp(map, r, bpm);
    return { map: w, bpm, avgBpm, q0: r.q0, range: r, srcDur: r.b - r.a, outDur: w.outDur, ratios: w.ratioRange(), loop: !!loop, tempo, alignment: map, cuts: null };
  });
  // The source a render is given runs half a second past the warp (`WarpRender.renderNow`), so the
  // last piece runs out where it does there.
  private readonly _cut = memo((plan: WarpPlan | null, mode: WarpMode, at: readonly number[], dur: number): WarpPlan | null =>
    (plan && mode === 'beats' ? { ...plan, cuts: planCuts(plan.map, at, Math.min(dur, plan.range.b + 0.5), plan.outDur) } : plan));

  private readonly _cutPoints = memo((markers: readonly Marker[], map: TempoMap, dur: number): number[] => {
    if (markers.length) return markers.map((k) => k.t);
    const out: number[] = [];
    eachStep(map, 0.25, 0, dur, (t) => out.push(t), 100000);
    return out;
  });
  /** Where Drums mode cuts: the transients of step 1, or the sixteenths of the tempo map when there are none. */
  get cutPoints(): readonly number[] { return this._cutPoints(this.markers, this.tempoMap, this.dur); }
  /**
   * The warp onto a straight grid: the whole file, or the loop alone when the Warp step says so. Null
   * without a tempo map, or when it is the loop and there is none.
   */
  get warpPlan(): WarpPlan | null {
    if (!this.audio || !this.hasMap) return null;
    const loop = this.warp.range === 'loop' ? this.activeLoop : null;
    if (this.warp.range === 'loop' && !loop) return null;
    const p = this._warp(this.alignment, this.tempoMap, this.doc.meter, this.dur, this.exportSettings.lead, loop, this.warp.bpm);
    return this._cut(p, this.warp.mode, this.warp.mode === 'beats' ? this.cutPoints : [], this.dur);
  }

  /**
   * What plays is the warp: from the Warp step on, heard warped, with something to warp. Transients and
   * Beats always hear the original, since the warp is made from what they find.
   */
  get hearingWarp(): boolean { return stepRules(this.step).hearsWarp && this.warp.listen && !!this.warpPlan; }

  private readonly _out = memo((plan: WarpPlan, meter: ProjectDoc['meter'], dur: number): WarpOut => warpOut(plan, meter, dur));
  /** The file a plan makes, and where the original lands in it. */
  outOf(plan: WarpPlan): WarpOut { return this._out(plan, this.doc.meter, this.dur); }
  /**
   * The warp Slice and Groove cut, measure and export, or null when they use the original: the warp as
   * it stands, whether or not its take has been rendered yet.
   */
  get warpOut(): WarpOut | null { return this.hearingWarp ? this.outOf(this.warpPlan!) : null; }

  /** Where the moment at original time t is in what Slice and Groove export: the warped file's time, or t. */
  placed(t: number): number { const o = this.warpOut; return o ? o.at(t) : t; }

  /**
   * The warp heard, or null for the original: what plays while something plays, which after an edit
   * is the take made before it until the next is ready; otherwise what would play.
   */
  get heard(): WarpOut | null { return this.playing ? this.playing.out : this.warpOut; }

  private readonly _timeline = memo((map: TempoMap, moved: Alignment | null, bpm: number | null, range: TimeRange | null, p: WarpPlan | null) =>
    new Timeline(map, moved, bpm, range, p?.cuts ? { cuts: p.cuts, q0: p.q0, outDur: p.outDur } : null));
  /**
   * Where everything is drawn and what the pointer lands on (`core/timeline.ts`). It follows what is
   * heard: the warp draws the audio moved onto the grid, the original draws it where it is. Drums mode
   * cuts rather than stretches, so there each piece is drawn whole where it is laid down.
   */
  get timeline(): Timeline {
    const h = this.heard, p = h?.plan;
    return p ? this._timeline(p.tempo, p.alignment, p.bpm, h.range, p) : this._timeline(this.tempoMap, null, null, null, null);
  }

  get dur(): number { return this.audio?.dur ?? 0; }
  get hasMap(): boolean { return this.doc.tempo.anchors.length > 0; }

  /** The loop when it is switched on and not empty. */
  get activeLoop(): TimeRange | null { return this.transport.loopOn ? usableLoop(this.transport.loop) : null; }

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

  selectedNote(): Note | null {
    const s = this.sel;
    return s && s.kind === 'note' ? (this.pickedNotes.find((n) => n.pitch === s.pitch && n.t === s.t) ?? null) : null;
  }

  selectedHit(): (EditedHit & { voice: Voice }) | null {
    const s = this.sel;
    if (!s || s.kind !== 'hit') return null;
    const h = this.drumHits?.[s.voice].find((k) => k.t === s.t);
    return h ? { ...h, voice: s.voice } : null;
  }

  // ---------- changes ----------
  /**
   * Makes new audio the one being worked on: everything that belongs to a file starts again from its
   * defaults, and a session restored afterwards brings back what it saved. The mixer and the other
   * preferences of this device stay.
   */
  load(audio: AudioAsset, analysis: Analysis, cands: readonly Candidate[], startBpm: number): void {
    this.audio = audio;
    this.analysis = analysis;
    this.cands = cands;
    this.drums = null;
    this.transcript = null;
    this.startBpm = startBpm;
    this.doc = emptyDoc(startBpm);
    this.history.clear();
    this.sel = null;
    this.hover = null;
    this.excluded = [];
    this.sliceSel = null;
    this.warpDrag = null;
    this.amp = 1;
    this.view.reset(audio.dur);
    this.transport = { ...this.transport, playhead: 0, start: 0, loop: null, loopOn: false };
    // The grid tempo, the material, what is warped and whether it is heard are this file's; so is the
    // shuffle, which is the feel of this take, and how its notes are found and held.
    this.warp = defaultWarp();
    this.notes = defaultNotes();
    this.beats = { ...this.beats, shuffle: defaultBeats().shuffle };
    this.bus.emit('audio', 'doc', 'candidates', 'drums', 'transcript', 'transport', 'view', 'playhead', 'selection', 'slices', 'warp', 'beats', 'notes');
  }

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
    this.view.reveal(this.timeline.axisAt(t));
    this.bus.emit('view');
  }
}
