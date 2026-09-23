// REAPER project (.rpp). Field layout follows the community "State Chunk Definitions" (ReaTeam/Doc):
// PT <seconds> <bpm> <shape 1=square> [<65536*den+num> <selected> <flags &1 = set time signature>]
import { type ExportOptions, type ExportPlan, type TempoPoint, planExport } from './midi';

export function rppQuote(n: string): string {
  if (!n.includes('"')) return '"' + n + '"';
  if (!n.includes("'")) return "'" + n + "'";
  return '"' + n.replace(/"/g, '') + '"';
}

const SOURCE_TYPES: Record<string, string> = {
  wav: 'WAVE', wave: 'WAVE', bwf: 'WAVE', w64: 'WAVE', aif: 'WAVE', aiff: 'WAVE',
  mp3: 'MP3', flac: 'FLAC', ogg: 'VORBIS', oga: 'VORBIS', opus: 'OPUS',
};
export function rppSourceType(name: string): string {
  const e = (name.split('.').pop() || '').toLowerCase();
  return SOURCE_TYPES[e] || 'VIDEO';
}

function header(bpm: number, sig: [number, number], now: number): string[] {
  return [`<REAPER_PROJECT 0.1 "7.0/BeatMapper" ${Math.floor(now / 1000)}`, '  RIPPLE 0', `  TEMPO ${bpm.toFixed(10)} ${sig[0]} ${sig[1]}`];
}

function tempoEnvelope(points: readonly TempoPoint[]): string[] {
  const L = ['  <TEMPOENVEX', '    ACT 1 -1', '    VIS 1 0 1', '    LANEHEIGHT 0 0', '    ARM 0', '    DEFSHAPE 1 -1 -1'];
  let prevB = -1;
  for (const p of points) {
    if (!p.sig && Math.abs(p.bpm - prevB) < 1e-7) continue;
    prevB = p.bpm;
    L.push(`    PT ${Math.max(0, p.time).toFixed(12)} ${p.bpm.toFixed(10)} 1` + (p.sig ? ` ${65536 * p.sig[1] + p.sig[0]} 0 1` : ''));
  }
  L.push('  >');
  return L;
}

export interface RppOptions extends ExportOptions {
  /** The audio file the project points at; no track is written without one. */
  fileName?: string;
  trackName?: string;
  /** Project timestamp, ms. */
  now?: number;
}

/** A project with the tempo map, and the audio on a track placed so its beats sit on the grid. */
export function buildRpp(o: RppOptions): { text: string; info: ExportPlan['info']; points: TempoPoint[] } {
  const plan = planExport(o), pts = plan.points, f = pts[0], sig0 = f.sig || [o.meter.num, o.meter.den];
  const L = header(f.bpm, sig0, o.now ?? Date.now());
  L.push(...tempoEnvelope(pts));
  if (o.fileName) {
    const off = o.trimmed ? plan.info.t0 : 0;
    L.push('  <TRACK', `    NAME ${rppQuote(o.trackName || 'Audio')}`, '    BEAT 0', '    <ITEM', '      POSITION 0', `      LENGTH ${(o.dur - off).toFixed(12)}`, '      LOOP 0', '      BEAT 0',
      `      NAME ${rppQuote(o.fileName)}`, `      SOFFS ${off.toFixed(12)}`, `      <SOURCE ${rppSourceType(o.fileName)}`, `        FILE ${rppQuote(o.fileName)}`, '      >', '    >', '  >');
  }
  L.push('>', '');
  return { text: L.join('\n'), info: plan.info, points: pts };
}

export interface NamedSlice {
  t0: number;
  t1: number;
  name: string;
}

// A REAPER project holding the slices: one item per slice on a single track, each at the time it was
// cut from, so the arrangement is rebuilt from the .wav files beside the .rpp. The tempo map rides
// along whenever the beats have been mapped.
export function buildRppSlices(o: RppOptions & { slices: readonly NamedSlice[] }): string {
  let plan: ExportPlan | null = null;
  if (!o.map.isEmpty) { try { plan = planExport(o); } catch { plan = null; } }
  const f = plan && plan.points[0], sig = (f && f.sig) || [o.meter.num, o.meter.den], bpm = f ? f.bpm : o.map.baseBpm;
  const L = header(bpm, sig, o.now ?? Date.now());
  if (plan) L.push(...tempoEnvelope(plan.points));
  L.push('  <TRACK', `    NAME ${rppQuote(o.trackName || 'Slices')}`, '    BEAT 0');
  for (const sl of o.slices) {
    L.push('    <ITEM', `      POSITION ${Math.max(0, sl.t0).toFixed(12)}`, `      LENGTH ${(sl.t1 - sl.t0).toFixed(12)}`, '      LOOP 0', '      BEAT 0',
      `      NAME ${rppQuote(sl.name)}`, '      SOFFS 0', `      <SOURCE ${rppSourceType(sl.name)}`, `        FILE ${rppQuote(sl.name)}`, '      >', '    >');
  }
  L.push('  >', '>', '');
  return L.join('\n');
}
