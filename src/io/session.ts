// The session file: markers, pins and settings for one audio file, never the audio itself. The same
// JSON is kept in localStorage per file and can be saved to carry the work to another device.
// Everything read back is validated and clamped, so a hand-edited or older file can't break the app.
import { ALGOS, type Algo, BANDS, type Band } from '../core/dsp/onset';
import { VOICES, type Voice } from '../core/drums/voices';
import { NOTE_MODES, type NoteMode } from '../core/notes/types';
import { DENOMINATORS, GRID_DIVISIONS, type GridDivision, type Meter } from '../core/tempo/meter';
import type { Anchor, TimeRange } from '../core/types';
import { type WarpMarker, placeWarpMarker } from '../core/warp/markers';
import { WARP_MODES, type WarpMode } from '../core/warp/modes';
import { WAV_RATES } from './formats/wav';
import {
  type BeatSettings, type DetectionSettings, type ExportSettings, type NoteSettings, SNAP_MODES, type SlicerSettings, type SnapMode, type TransportState, type WarpSettings,
  defaultNotes, defaultWarp,
} from '../state/settings';
import { STEPS, type Step } from '../state/steps';

export const SESSION_FORMAT = 'beatmapper-session';
export const SESSION_VERSION = 1;

/** Everything a session holds, in the app's own terms. */
export interface SessionContent {
  audio: { name: string; fileName: string; duration: number; sampleRate: number };
  detection: DetectionSettings;
  markers: { manual: number[]; removed: number[] };
  meter: Meter;
  tempo: { anchors: Anchor[]; baseBpm: number };
  beats: Omit<BeatSettings, 'loopBars'>;
  transport: Pick<TransportState, 'loop' | 'loopOn' | 'start' | 'playhead' | 'stay' | 'click'>;
  view: TimeRange | null;
  step: Step;
  export: ExportSettings;
  slicer: SlicerSettings;
  /** Start times of the slices the user dropped. */
  excluded: number[];
  /** Transients put on a grid line in the Warp step, sorted by time. */
  warpMarkers: WarpMarker[];
  /** The Warp step's settings: the material, the grid tempo, what is warped, whether it is heard, quantize's strength, filling Drums mode's gaps. */
  warp: WarpSettings;
  /** Drum hits edited by hand in the Groove step: added (with their loudness) and deleted, by time. */
  hits: { manual: { voice: Voice; t: number; a: number }[]; removed: { voice: Voice; t: number }[] };
  /** The Notes step's settings: a line or chords, the sensitivity, Legato. */
  notes: NoteSettings;
  /** Notes deleted by hand in the Notes step, by pitch and start. */
  removedNotes: { pitch: number; t: number }[];
}

/** The JSON written to disk (format version 1). */
export function toSessionJson(s: SessionContent): object {
  return {
    format: SESSION_FORMAT,
    version: SESSION_VERSION,
    audio: s.audio,
    detection: { sens: s.detection.sens, gap: s.detection.gap, band: s.detection.band, algo: s.detection.algo, overlay: s.detection.showOdf },
    markers: { manual: s.markers.manual, removed: s.markers.removed },
    beats: {
      num: s.meter.num, den: s.meter.den, grid: s.beats.grid, baseBpm: s.tempo.baseBpm, mapEvery: s.beats.mapEvery, tol: s.beats.tol,
      snapTo: s.beats.snapTo, snap: s.beats.snapTo !== 'off', anchors: s.tempo.anchors.map((a) => ({ q: a.q, t: a.t, manual: !!a.manual })),
      ...(s.beats.shuffle ? { shuffle: s.beats.shuffle } : {}),
    },
    transport: s.transport,
    view: s.view ? { t0: s.view.a, t1: s.view.b } : null,
    step: s.step,
    export: s.export,
    slicer: slicerJson(s),
    // Added to version 1 without a bump, like step 5, and so is the shuffle above: only written when
    // it differs from how the app starts, so a session without it saves byte-identical, and a reader
    // that predates it ignores the field. The Groove step's own quantize (`groove.quantize`) was
    // written here too; the warp's quantize is the only one now, so older files' is ignored. The
    // other Warp settings and the hit edits came later still, and are written the same way. The warp's
    // quantize strength was `warp.quantize` while it only set how far the Quantize button went; now
    // that it is the quantize itself it is `warp.strength`, so an older file's slider position isn't
    // read as a quantize it never had.
    ...warpJson(s),
    ...hitsJson(s),
    ...notesJson(s),
  };
}

function warpJson(s: SessionContent): object {
  const w0 = defaultWarp(), w = s.warp;
  const out = {
    ...(s.warpMarkers.length ? { markers: s.warpMarkers.map((m) => ({ t: m.t, q: m.q })) } : {}),
    ...(w.quantize !== w0.quantize ? { strength: w.quantize } : {}),
    ...(w.mode !== w0.mode ? { mode: w.mode } : {}),
    ...(w.bpm !== w0.bpm ? { bpm: w.bpm } : {}),
    ...(w.range !== w0.range ? { range: w.range } : {}),
    ...(w.listen !== w0.listen ? { listen: w.listen } : {}),
    ...(w.fill !== w0.fill ? { fill: w.fill } : {}),
  };
  return Object.keys(out).length ? { warp: out } : {};
}

// The Notes step came after the hit edits, and is written the same way: only what differs from how
// the step starts, so a session that never opened it saves byte-identical.
function notesJson(s: SessionContent): object {
  const n0 = defaultNotes(), n = s.notes;
  const out = {
    ...(n.mode !== n0.mode ? { mode: n.mode } : {}),
    ...(n.sens !== n0.sens ? { sens: n.sens } : {}),
    ...(n.legato !== n0.legato ? { legato: n.legato } : {}),
    ...(s.removedNotes.length ? { removed: s.removedNotes.map((r) => ({ pitch: r.pitch, t: r.t })) } : {}),
  };
  return Object.keys(out).length ? { notes: out } : {};
}

function hitsJson(s: SessionContent): object {
  const { manual, removed } = s.hits;
  if (!manual.length && !removed.length) return {};
  return { drums: { manual: manual.map((h) => ({ voice: h.voice, t: h.t, a: h.a })), removed: removed.map((h) => ({ voice: h.voice, t: h.t })) } };
}

// Key order as version 1 files have always had it, so an unchanged session saves byte-identical. The
// sample rate and the dither came later and are written only when set, like the warp's settings.
function slicerJson(s: SessionContent): object {
  const { csv, rate, dither, ...rest } = s.slicer;
  return { ...rest, excluded: s.excluded, csv, ...(rate != null ? { rate } : {}), ...(dither ? { dither } : {}) };
}

export const isSessionJson = (d: unknown): boolean => !!d && typeof d === 'object' && (d as { format?: unknown }).format === SESSION_FORMAT;

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const fin = (v: unknown, d: number): number => (Number.isFinite(+(v as number)) ? +(v as number) : d);
const oneOf = <T>(list: readonly T[], v: unknown, d: T): T => (list.includes(v as T) ? (v as T) : d);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/**
 * Reads a session (any version this app knows) for audio of length `dur`. Missing or bad fields fall
 * back to `fallback` where it makes sense (band, algorithm, tempo) and to the defaults otherwise.
 */
export function parseSession(d: Json, dur: number, fallback: { band: Band; algo: Algo; baseBpm: number }): SessionContent {
  if (!isSessionJson(d)) throw new Error('Not a BeatMapper session');
  const det = d.detection || {}, mk = d.markers || {}, bt = d.beats || {}, tr = d.transport || {}, ex = d.export || {}, sl = d.slicer || {};
  const T = (t: unknown): t is number => Number.isFinite(t) && (t as number) >= 0 && (t as number) <= dur + 1e-6;

  const anchors: Anchor[] = [];
  const raw = (Array.isArray(bt.anchors) ? bt.anchors : []).filter((a: Json) => a && Number.isFinite(a.q) && T(a.t)).sort((p: Json, q: Json) => p.q - q.q);
  for (const a of raw) {
    const l = anchors[anchors.length - 1];
    if (!l || (a.q > l.q + 1e-9 && a.t > l.t)) anchors.push({ q: a.q, t: a.t, manual: !!a.manual });
  }
  const loop = tr.loop && T(tr.loop.a) && T(tr.loop.b) && tr.loop.b > tr.loop.a ? { a: tr.loop.a, b: tr.loop.b } : null;
  const start = T(tr.start) ? tr.start : 0;
  const snapTo: SnapMode = SNAP_MODES.includes(bt.snapTo) ? bt.snapTo : bt.snap === false ? 'off' : 'markers';
  const view = d.view && T(d.view.t0) && T(d.view.t1) && d.view.t1 > d.view.t0 ? { a: d.view.t0, b: d.view.t1 } : null;
  const au = d.audio || {};
  // Placed one by one as the app places them, so a hand-edited file can't hold two that cross.
  let warpMarkers: WarpMarker[] = [];
  for (const w of (Array.isArray(d.warp?.markers) ? d.warp.markers : []).slice(0, 20000)) {
    if (!w || !T(w.t) || !Number.isFinite(w.q)) continue;
    const r = placeWarpMarker(warpMarkers, w.t, w.q);
    if (r.ok) warpMarkers = r.markers;
  }
  const w = d.warp || {}, w0 = defaultWarp(), dr = d.drums || {}, nt = d.notes || {}, n0 = defaultNotes();
  const V = (v: unknown): v is Voice => VOICES.includes(v as Voice);
  const hits: SessionContent['hits'] = {
    manual: (Array.isArray(dr.manual) ? dr.manual : []).filter((h: Json) => h && V(h.voice) && T(h.t)).slice(0, 20000)
      .map((h: Json) => ({ voice: h.voice, t: h.t, a: clamp(fin(h.a, 1), 0, 1e6) })),
    removed: (Array.isArray(dr.removed) ? dr.removed : []).filter((h: Json) => h && V(h.voice) && T(h.t)).slice(0, 20000)
      .map((h: Json) => ({ voice: h.voice, t: h.t })),
  };

  return {
    audio: { name: String(au.name ?? ''), fileName: String(au.fileName ?? ''), duration: fin(au.duration, dur), sampleRate: fin(au.sampleRate, 0) },
    detection: {
      sens: clamp(fin(det.sens, 55), 0, 100),
      gap: clamp(fin(det.gap, 60), 10, 300),
      band: oneOf<Band>(BANDS, det.band, fallback.band),
      algo: oneOf<Algo>(ALGOS, det.algo, fallback.algo),
      showOdf: typeof det.overlay === 'boolean' ? det.overlay : true,
    },
    markers: {
      manual: (Array.isArray(mk.manual) ? mk.manual : []).filter(T).sort((a: number, b: number) => a - b),
      removed: (Array.isArray(mk.removed) ? mk.removed : []).filter(T),
    },
    meter: { num: clamp(Math.round(fin(bt.num, 4)), 1, 32), den: oneOf(DENOMINATORS, +bt.den, 4) },
    tempo: { anchors, baseBpm: clamp(fin(bt.baseBpm, fallback.baseBpm), 20, 400) },
    beats: {
      grid: oneOf<GridDivision>(GRID_DIVISIONS, String(bt.grid), '16'),
      mapEvery: bt.mapEvery === 'bar' ? 'bar' : 'beat',
      tol: clamp(fin(bt.tol, 20), 5, 45),
      snapTo,
      shuffle: clamp(Math.round(fin(bt.shuffle, 0)), 0, 100),
    },
    transport: { loop, loopOn: !!tr.loopOn && !!loop, start, playhead: T(tr.playhead) ? tr.playhead : start, stay: !!tr.stay, click: !!tr.click },
    view,
    // Steps 5 (Groove) and 6 (Notes) came later; a version 1 reader that predates them falls back to 1.
    step: oneOf<Step>(STEPS, d.step, 1),
    export: {
      lead: ex.lead === 'trim' ? 'trim' : 'full',
      res: oneOf(['pins', 'bar', 'beat'] as const, ex.res, 'pins'),
      clicks: 'clicks' in ex ? !!ex.clicks : true,
      rppAudio: 'rppAudio' in ex ? !!ex.rppAudio : true,
    },
    slicer: {
      mode: sl.mode === 'fixed' ? 'fixed' : 'gap',
      len: clamp(fin(sl.len, 500), 5, 60000),
      tail: clamp(fin(sl.tail, 0), 0, 5000),
      fadeIn: clamp(fin(sl.fadeIn, 1), 0, 500),
      fadeOut: clamp(fin(sl.fadeOut, 8), 0, 2000),
      min: clamp(fin(sl.min, 40), 0, 5000),
      mono: !!sl.mono,
      bits: +sl.bits === 16 ? 16 : 24,
      rate: oneOf<number | null>(WAV_RATES, +sl.rate, null),
      dither: sl.dither === true,
      norm: !!sl.norm,
      target: clamp(fin(sl.target, -1), -24, 0),
      naming: sl.naming === 'time' ? 'time' : 'num',
      csv: 'csv' in sl ? !!sl.csv : true,
    },
    excluded: Array.isArray(sl.excluded) ? sl.excluded.filter(T).slice(0, 5000) : [],
    warpMarkers,
    warp: {
      mode: oneOf<WarpMode>(WARP_MODES, w.mode, w0.mode),
      bpm: Number.isFinite(w.bpm) ? clamp(+w.bpm, 20, 400) : w0.bpm,
      range: w.range === 'loop' ? 'loop' : w0.range,
      listen: typeof w.listen === 'boolean' ? w.listen : w0.listen,
      quantize: clamp(Math.round(fin(w.strength, w0.quantize)), 0, 100),
      fill: typeof w.fill === 'boolean' ? w.fill : w0.fill,
    },
    hits,
    notes: {
      mode: oneOf<NoteMode>(NOTE_MODES, nt.mode, n0.mode),
      sens: clamp(Math.round(fin(nt.sens, n0.sens)), 0, 100),
      legato: typeof nt.legato === 'boolean' ? nt.legato : n0.legato,
    },
    removedNotes: (Array.isArray(nt.removed) ? nt.removed : [])
      .filter((r: Json) => r && Number.isInteger(r.pitch) && r.pitch >= 0 && r.pitch <= 127 && T(r.t)).slice(0, 20000)
      .map((r: Json) => ({ pitch: r.pitch, t: r.t })),
  };
}
