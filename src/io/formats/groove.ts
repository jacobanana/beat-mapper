// A measured groove as a Pocket Science pattern (its groove-atlas-v2 format): one bar of steps per
// voice, each with a velocity and a micro-timing offset in ticks at 480 per quarter note. The bar is
// the typical bar of the take: a step is in it when it was played in at least half the bars, with
// the median velocity and offset over those bars.
import { GM_NOTE, VOICES, type Voice } from '../../core/drums/voices';
import { type Groove, PPQ } from '../../core/groove/pocket';

export const GROOVE_FORMAT = 'groove-atlas-v2';

export interface GrooveHit {
  step: number;
  vel: number;
  off_ticks: number;
  off_pct_step: number;
  off_approx: string;
  off_ms_at_native_bpm: number;
}

export interface GroovePattern {
  id: string;
  name: string;
  chapter: string;
  genre: string;
  bpm: number;
  grid: number;
  bars: number;
  /** Always null: the swing is already in the offsets, and Pocket Science would add it again. */
  swing_16th: null;
  feel: string;
  tracks: Partial<Record<Voice, GrooveHit[]>>;
  measured: { source: string; bars: number; reference: string; presence: number };
}

// Nearest note-value fraction of a whole note (1920 ticks), as Pocket Science writes it: "+1/192".
export function offApprox(ticks: number): string {
  const a = Math.abs(ticks);
  if (a < 0.5) return '0';
  let best = 16;
  for (const d of [16, 24, 32, 48, 64, 96, 128, 192, 256, 384]) if (Math.abs(1920 / d - a) < Math.abs(1920 / best - a)) best = d;
  return `${ticks > 0 ? '+' : '-'}1/${best}`;
}

export function groovePattern(g: Groove, name: string, feel: string, presence = 0.5): GroovePattern {
  const tracks: Partial<Record<Voice, GrooveHit[]>> = {};
  for (const v of VOICES) {
    const hits = g.steps
      .filter((s) => s.voice === v && s.presence >= presence)
      .map((s): GrooveHit => {
        const ticks = Math.round(s.ticks);
        return { step: s.step, vel: s.vel, off_ticks: ticks, off_pct_step: Math.round(s.frac * 100), off_approx: offApprox(ticks), off_ms_at_native_bpm: Math.round(s.ms) };
      });
    if (hits.length) tracks[v] = hits;
  }
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'measured';
  return {
    id, name, chapter: 'Measured', genre: '', bpm: Math.round(g.bpm * 10) / 10, grid: g.stepsPerBar, bars: 1, swing_16th: null, feel, tracks,
    measured: { source: 'BeatMapper', bars: g.bars, reference: g.ref, presence },
  };
}

/** The whole file: the format header Pocket Science reads, with one pattern in it. */
export function grooveJson(g: Groove, name: string, feel: string): object {
  return {
    format: GROOVE_FORMAT,
    ppq: PPQ,
    note_map: Object.fromEntries(VOICES.map((v) => [v, GM_NOTE[v]])),
    offset_convention: 'BEAT-BASED: off_ticks @ PPQ 480 (negative = ahead, positive = behind), measured against the reference voice.',
    patterns: [groovePattern(g, name, feel)],
  };
}
