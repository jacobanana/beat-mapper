// The session file: markers, pins and settings for one audio file, never the audio itself. The same
// JSON is kept in localStorage per file and can be saved to carry the work to another device.
// Everything read back is validated and clamped, so a hand-edited or older file can't break the app.
import { ALGOS, type Algo, BANDS, type Band } from '../core/dsp/onset';
import { DENOMINATORS, GRID_DIVISIONS, type GridDivision, type Meter } from '../core/tempo/meter';
import type { Anchor, TimeRange } from '../core/types';
import { type WarpMarker, placeWarpMarker } from '../core/warp/markers';
import {
  type BeatSettings, type DetectionSettings, type ExportSettings, SNAP_MODES, type SlicerSettings, type SnapMode, type TransportState,
} from '../state/settings';

export const SESSION_FORMAT = 'beatmapper-session';
export const SESSION_VERSION = 1;

export type Step = 1 | 2 | 3 | 4 | 5;

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
    },
    transport: s.transport,
    view: s.view ? { t0: s.view.a, t1: s.view.b } : null,
    step: s.step,
    export: s.export,
    slicer: slicerJson(s),
    // Added to version 1 without a bump, like step 5: only written when there are some, so a session
    // without them saves byte-identical, and a reader that predates them ignores the field.
    ...(s.warpMarkers.length ? { warp: { markers: s.warpMarkers.map((w) => ({ t: w.t, q: w.q })) } } : {}),
  };
}

// Key order as version 1 files have always had it, so an unchanged session saves byte-identical.
function slicerJson(s: SessionContent): object {
  const { csv, ...rest } = s.slicer;
  return { ...rest, excluded: s.excluded, csv };
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
    },
    transport: { loop, loopOn: !!tr.loopOn && !!loop, start, playhead: T(tr.playhead) ? tr.playhead : start, stay: !!tr.stay, click: !!tr.click },
    view,
    // Step 5 (Groove) came later; a version 1 reader that predates it falls back to 1.
    step: oneOf<Step>([1, 2, 3, 4, 5], d.step, 1),
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
      bits: +sl.bits === 24 ? 24 : 16,
      norm: !!sl.norm,
      target: clamp(fin(sl.target, -1), -24, 0),
      naming: sl.naming === 'time' ? 'time' : 'num',
      csv: 'csv' in sl ? !!sl.csv : true,
    },
    excluded: Array.isArray(sl.excluded) ? sl.excluded.filter(T).slice(0, 5000) : [],
    warpMarkers,
  };
}
