// Drum hits edited by hand, applied on top of what the detector found. A detected hit is known by
// its voice and time, so a deletion survives a change of sensitivity; a placed hit has an id, so it
// can be dragged. Moving a detected hit deletes it and places a copy.
import { type DrumHit, type PerVoice, type Voice, perVoice } from './voices';

export interface ManualHit {
  readonly id: number;
  readonly voice: Voice;
  readonly t: number;
  /** Loudness, taken from the audio where it was placed: it sets the hit's velocity. */
  readonly a: number;
}

export interface RemovedHit {
  readonly voice: Voice;
  readonly t: number;
}

export interface HitEdits {
  readonly manual: readonly ManualHit[];
  readonly removed: readonly RemovedHit[];
  readonly nextId: number;
}

/** A hit as the rest of the app sees it; `id` is set on the ones placed by hand. */
export interface EditedHit extends DrumHit {
  readonly id?: number;
}

export const noHitEdits = (): HitEdits => ({ manual: [], removed: [], nextId: 1 });

/** The selected hits minus the deleted ones, plus the placed ones, each voice sorted by time. */
export function applyHitEdits(hits: PerVoice<readonly DrumHit[]>, e: HitEdits): PerVoice<EditedHit[]> {
  if (!e.manual.length && !e.removed.length) return perVoice((v) => [...hits[v]]);
  return perVoice((v) => {
    const rm = new Set(e.removed.filter((r) => r.voice === v).map((r) => r.t));
    const out: EditedHit[] = hits[v].filter((h) => !rm.has(h.t));
    for (const m of e.manual) if (m.voice === v) out.push({ t: m.t, s: 1, a: m.a, id: m.id });
    return out.sort((a, b) => a.t - b.t);
  });
}

/**
 * How loud a hit placed at t is: the loudness of the closest hit the detector saw within `within`
 * seconds (`all`, sensitivity aside), else the median of the hits kept (`kept`), so a hit placed
 * where the detector saw nothing still gets a usual velocity.
 */
export function loudnessAt(all: readonly DrumHit[], kept: readonly DrumHit[], t: number, within = 0.03): number {
  let best: DrumHit | null = null;
  for (const h of all) if (Math.abs(h.t - t) <= within && (!best || Math.abs(h.t - t) < Math.abs(best.t - t))) best = h;
  if (best) return best.a;
  const pool = kept.length ? kept : all;
  if (!pool.length) return 1;
  const a = pool.map((h) => h.a).sort((x, y) => x - y);
  return a[a.length >> 1];
}
