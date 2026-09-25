// The project document: everything the user edits that undo covers. It is immutable; every edit
// produces a new document, and the undo history keeps the old ones.
import { type HitEdits, noHitEdits } from '../core/drums/edit';
import type { ManualMarker } from '../core/markers/detect';
import { type NoteEdits, noNoteEdits } from '../core/notes/select';
import type { Meter } from '../core/tempo/meter';
import type { Anchor } from '../core/types';
import type { WarpMarker } from '../core/warp/markers';

export interface MarkerEdits {
  /** Markers placed or moved by hand. */
  readonly manual: readonly ManualMarker[];
  /** Times of the detected candidates the user deleted. */
  readonly removed: readonly number[];
  /** Id for the next manual marker. */
  readonly nextId: number;
}

export interface TempoDoc {
  /** Pins, sorted by q. */
  readonly anchors: readonly Anchor[];
  /** Tempo used after the last pin, for a lone bar 1, and to seed auto-mapping. */
  readonly baseBpm: number;
}

export interface ProjectDoc {
  readonly meter: Meter;
  readonly tempo: TempoDoc;
  readonly markers: MarkerEdits;
  /** Drum hits added, moved and deleted by hand in the Groove step. */
  readonly drums: HitEdits;
  /** Transients put on a grid line by hand in the Warp step, sorted by time. */
  readonly warpMarkers: readonly WarpMarker[];
  /** Notes deleted by hand in the Notes step. */
  readonly notes: NoteEdits;
}

export const emptyDoc = (baseBpm = 120): ProjectDoc => ({
  meter: { num: 4, den: 4 },
  tempo: { anchors: [], baseBpm },
  markers: { manual: [], removed: [], nextId: 1 },
  drums: noHitEdits(),
  warpMarkers: [],
  notes: noNoteEdits(),
});

export const withAnchors = (d: ProjectDoc, anchors: readonly Anchor[], baseBpm = d.tempo.baseBpm): ProjectDoc => ({
  ...d,
  tempo: { anchors: [...anchors].sort((a, b) => a.q - b.q), baseBpm },
});

export const withMarkers = (d: ProjectDoc, m: Partial<MarkerEdits>): ProjectDoc => ({ ...d, markers: { ...d.markers, ...m } });

/** Adds a manual marker at t. Returns the document and the new marker's id. */
export function addManual(d: ProjectDoc, t: number): [ProjectDoc, number] {
  const id = d.markers.nextId;
  return [withMarkers(d, { manual: [...d.markers.manual, { id, t }].sort((a, b) => a.t - b.t), nextId: id + 1 }), id];
}

export const moveManual = (d: ProjectDoc, id: number, t: number): ProjectDoc =>
  withMarkers(d, { manual: d.markers.manual.map((m) => (m.id === id ? { id, t } : m)) });

export const sortManual = (d: ProjectDoc): ProjectDoc =>
  withMarkers(d, { manual: [...d.markers.manual].sort((a, b) => a.t - b.t) });

export const removeCandidate = (d: ProjectDoc, t: number): ProjectDoc =>
  d.markers.removed.includes(t) ? d : withMarkers(d, { removed: [...d.markers.removed, t] });

export const withHits = (d: ProjectDoc, e: Partial<HitEdits>): ProjectDoc => ({ ...d, drums: { ...d.drums, ...e } });

export const withNoteEdits = (d: ProjectDoc, e: Partial<NoteEdits>): ProjectDoc => ({ ...d, notes: { ...d.notes, ...e } });
