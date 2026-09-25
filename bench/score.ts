// Note-level transcription scores, as mir_eval computes them (Raffel et al., ISMIR 2014): a found note
// matches a true one of the same pitch whose onset is within 50 ms, each note matched once; with
// offsets, its end must also be within 20% of the true note's length or 50 ms, whichever is more.

export interface Timed {
  pitch: number;
  t: number;
  end: number;
}

export interface Score {
  truth: number;
  found: number;
  matched: number;
  /** Matched on onset and offset both. */
  matchedEnds: number;
  /** Absolute onset errors of the matched notes, ms. */
  errors: number[];
}

// Greedy on onset distance, closest pairs first: the same pairing as a maximum matching whenever the
// notes of one pitch are further apart than twice the tolerance, as they nearly always are.
function pair(truth: readonly Timed[], found: readonly Timed[], ends: boolean): [number, number][] {
  const cand: [number, number, number][] = [];
  const byPitch = new Map<number, number[]>();
  found.forEach((f, j) => { const a = byPitch.get(f.pitch) ?? []; a.push(j); byPitch.set(f.pitch, a); });
  truth.forEach((n, i) => {
    for (const j of byPitch.get(n.pitch) ?? []) {
      const f = found[j], d = Math.abs(f.t - n.t);
      if (d > 0.05) continue;
      if (ends && Math.abs(f.end - n.end) > Math.max(0.05, 0.2 * (n.end - n.t))) continue;
      cand.push([d, i, j]);
    }
  });
  cand.sort((a, b) => a[0] - b[0]);
  const ti = new Set<number>(), fj = new Set<number>(), out: [number, number][] = [];
  for (const [, i, j] of cand) if (!ti.has(i) && !fj.has(j)) { ti.add(i); fj.add(j); out.push([i, j]); }
  return out;
}

export function score(truth: readonly Timed[], found: readonly Timed[]): Score {
  const p = pair(truth, found, false);
  return {
    truth: truth.length,
    found: found.length,
    matched: p.length,
    matchedEnds: pair(truth, found, true).length,
    errors: p.map(([i, j]) => Math.abs(found[j].t - truth[i].t) * 1000),
  };
}

export function sum(a: readonly Score[]): Score {
  return a.reduce((s, x) => ({
    truth: s.truth + x.truth, found: s.found + x.found, matched: s.matched + x.matched,
    matchedEnds: s.matchedEnds + x.matchedEnds, errors: s.errors.concat(x.errors),
  }), { truth: 0, found: 0, matched: 0, matchedEnds: 0, errors: [] as number[] });
}

/** Precision, recall and F-measure, on onsets and on onsets with offsets. */
export function prf(s: Score): { p: number; r: number; f: number; fEnds: number } {
  const p = s.found ? s.matched / s.found : 0, r = s.truth ? s.matched / s.truth : 0;
  const pe = s.found ? s.matchedEnds / s.found : 0, re = s.truth ? s.matchedEnds / s.truth : 0;
  return { p, r, f: p + r ? (2 * p * r) / (p + r) : 0, fEnds: pe + re ? (2 * pe * re) / (pe + re) : 0 };
}
