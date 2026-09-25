import type { Meter } from '../../core/tempo/meter';
import type { TempoMap } from '../../core/tempo/tempo-map';

export type TempoResolution = 'pins' | 'bar' | 'beat';

export interface ExportOptions {
  map: TempoMap;
  meter: Meter;
  /** Length of the audio, seconds. */
  dur: number;
  /** Where the tempo may change: at every pin, bar or beat. */
  mode: TempoResolution;
  /** The audio is trimmed to start on bar 1 (otherwise a lead-in is written before it). */
  trimmed: boolean;
  /** Add a click track. */
  clicks?: boolean;
  /** Notes to write on a drum track (GM channel 10), at their own times: micro-timing and all. */
  notes?: readonly DrumNote[];
  /** Pitched notes to write on a track of their own (channel 1), with their lengths and pitch bends. */
  pitched?: readonly PitchedNote[];
}

export interface DrumNote {
  /** Seconds in the audio. */
  t: number;
  note: number;
  vel: number;
}

export interface PitchedNote {
  /** Start and end, seconds in the audio. */
  t: number;
  end: number;
  /** MIDI note number. */
  pitch: number;
  vel: number;
  /** Bend points: seconds in the audio, cents off the note (within the ±2 semitones written). */
  bend?: readonly { t: number; cents: number }[];
}

export interface TempoPoint {
  tick: number;
  /** Seconds in the project. */
  time: number;
  /** Quarter notes per minute. */
  bpm: number;
  sig: [number, number] | null;
}

export interface ExportInfo {
  /** Tempo changes written. */
  count: number;
  minB: number;
  maxB: number;
  /** Time of bar 1 in the audio. */
  t0: number;
  /** Tempo of the lead-in before bar 1, if there is one. */
  leadBpm: number | null;
  /** Bars the lead-in takes. */
  leadBars: number;
  songBpm: number;
  n16: number;
}

export interface ExportPlan {
  ppq: number;
  points: TempoPoint[];
  leadTicks: number;
  beatQ: number;
  info: ExportInfo;
}

const simplifySig = (n16: number): [number, number] => (n16 % 4 === 0 ? [n16 / 4, 4] : n16 % 2 === 0 ? [n16 / 2, 8] : [n16, 16]);

// One plan feeds both writers (MIDI and REAPER). Before bar 1 the audio's lead-in becomes whole
// sixteenths at their own tempo, with a shortened first bar, so bar 1 lands on a bar line.
export function planExport(o: ExportOptions): ExportPlan {
  const ppq = 480, { num, den } = o.meter, barQ = (num * 4) / den, beatQ = 4 / den;
  const A = o.map.anchors.filter((a) => a.q >= -1e-9);
  let pts: { q: number; t: number }[] = [];
  if (o.mode === 'pins') {
    pts = A.map((a) => ({ q: a.q, t: a.t }));
    if (pts.length === 1) pts.push({ q: pts[0].q + barQ, t: pts[0].t + (barQ * 60) / o.map.baseBpm });
  } else {
    const step = o.mode === 'bar' ? barQ : beatQ;
    for (let k = 0; k < 100000; k++) {
      const q = k * step, t = o.map.posToTime(q);
      pts.push({ q, t });
      if (t >= o.dur && k > 0) break;
    }
  }
  const P: { tick: number; t: number }[] = [];
  for (const p of pts) {
    const tick = Math.round(p.q * ppq);
    if (!P.length || (tick > P[P.length - 1].tick && p.t > P[P.length - 1].t)) P.push({ tick, t: p.t });
  }
  const t0 = P[0].t, spq0 = (P[1].t - P[0].t) / ((P[1].tick - P[0].tick) / ppq);
  const lead = !o.trimmed && t0 > 0.002, shift = o.trimmed ? -t0 : 0;
  let leadTicks = 0, leadBpm: number | null = null, n16 = 0, bars = 0;
  const points: TempoPoint[] = [];
  if (lead) {
    n16 = Math.max(1, Math.round(t0 / (spq0 / 4)));
    leadTicks = (n16 * ppq) / 4;
    leadBpm = (60 * (n16 / 4)) / t0;
    const bar16 = (num * 16) / den, r = n16 % bar16;
    bars = Math.floor(n16 / bar16) + (r ? 1 : 0);
    points.push({ tick: 0, time: 0, bpm: leadBpm, sig: r ? simplifySig(r) : [num, den] });
    if (r && r < n16) points.push({ tick: (r * ppq) / 4, time: (t0 * r) / n16, bpm: leadBpm, sig: [num, den] });
  }
  for (let i = 0; i < P.length - 1; i++) {
    const bpm = (60 * ((P[i + 1].tick - P[i].tick) / ppq)) / (P[i + 1].t - P[i].t), tick = leadTicks + P[i].tick;
    const prev = points[points.length - 1];
    const needSig = i === 0 && (!lead || prev.sig![0] !== num || prev.sig![1] !== den);
    points.push({ tick, time: P[i].t + shift, bpm, sig: needSig ? [num, den] : null });
  }
  let minB = Infinity, maxB = 0, count = 0, last = -1;
  for (const p of points) {
    const u = Math.round(6e7 / p.bpm);
    if (u !== last) { count++; last = u; }
    if (p.tick >= leadTicks) { if (p.bpm < minB) minB = p.bpm; if (p.bpm > maxB) maxB = p.bpm; }
  }
  return { ppq, points, leadTicks, beatQ, info: { count, minB, maxB, t0, leadBpm, leadBars: bars, songBpm: 60 / spq0, n16 } };
}

// ---- Standard MIDI File writer ----
const vlq = (n: number): number[] => {
  const b = [n & 127];
  while ((n >>= 7) > 0) b.unshift((n & 127) | 128);
  return b;
};
interface MidiEvent { tick: number; pr: number; data: number[] }
function track(events: MidiEvent[]): number[] {
  events.sort((a, b) => a.tick - b.tick || a.pr - b.pr);
  const bytes: number[] = [];
  let last = 0;
  for (const e of events) { bytes.push(...vlq(e.tick - last), ...e.data); last = e.tick; }
  bytes.push(0, 0xff, 0x2f, 0);
  const len = bytes.length;
  return [0x4d, 0x54, 0x72, 0x6b, (len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255, ...bytes];
}
const metaText = (type: number, str: string): number[] => {
  const b = [...new TextEncoder().encode(str)];
  return [0xff, type, ...vlq(b.length), ...b];
};

/** A type-1 MIDI file: the tempo map, and optionally a click track on the GM percussion channel. */
export function buildMidi(o: ExportOptions): { bytes: Uint8Array; info: ExportInfo } {
  const plan = planExport(o), { ppq, leadTicks, beatQ } = plan;
  const ev: MidiEvent[] = [{ tick: 0, pr: 0, data: metaText(3, 'Tempo map') }];
  let lastU = -1;
  for (const p of plan.points) {
    if (p.sig) ev.push({ tick: p.tick, pr: 1, data: [0xff, 0x58, 4, p.sig[0], Math.log2(p.sig[1]) | 0, 24, 8] });
    const u = Math.max(1, Math.min(0xffffff, Math.round(6e7 / p.bpm)));
    if (u === lastU) continue;
    lastU = u;
    ev.push({ tick: p.tick, pr: 2, data: [0xff, 0x51, 3, (u >>> 16) & 255, (u >>> 8) & 255, u & 255] });
  }
  const tracks = [track(ev)];
  if (o.clicks) {
    const nv: MidiEvent[] = [{ tick: 0, pr: 0, data: metaText(3, 'Click') }];
    const bt = Math.round(beatQ * ppq), len = Math.max(10, Math.round(bt / 4));
    const add = (tick: number, down: boolean) => {
      const n = down ? 76 : 77, v = down ? 112 : 84;
      nv.push({ tick, pr: 4, data: [0x99, n, v] }, { tick: tick + len, pr: 3, data: [0x89, n, 0] });
    };
    for (let j = 1; leadTicks - j * bt >= 0; j++) add(leadTicks - j * bt, false);
    const endQ = o.map.timeToPos(o.dur);
    for (let k = 0; k * beatQ < endQ && k < 200000; k++) add(leadTicks + Math.round(k * beatQ * ppq), k % o.meter.num === 0);
    tracks.push(track(nv));
  }
  // A note's tick is its place on the tempo map, so it lands where it was played against the tempo
  // track written above: exactly with a tempo change at every pin (the map is straight between pins),
  // to within the rounding of one tick otherwise. In the lead-in the tempo is the lead-in's.
  const t0 = plan.info.t0, tickOf = (t: number): number => {
    const q = o.map.timeToPos(t);
    const tick = q >= 0 ? leadTicks + Math.round(q * ppq) : !o.trimmed && t0 > 0 ? Math.round((t / t0) * leadTicks) : -1;
    return Number.isFinite(tick) ? tick : -1;
  };
  if (o.notes?.length) {
    const dv: MidiEvent[] = [{ tick: 0, pr: 0, data: metaText(3, 'Drums') }], len = ppq / 8;
    for (const n of o.notes) {
      const tick = tickOf(n.t);
      if (tick < 0) continue;
      const v = Math.max(1, Math.min(127, Math.round(n.vel)));
      dv.push({ tick, pr: 4, data: [0x99, n.note, v] }, { tick: tick + len, pr: 3, data: [0x89, n.note, 0] });
    }
    tracks.push(track(dv));
  }
  if (o.pitched?.length) tracks.push(track(pitchedEvents(o.pitched, tickOf)));
  const head = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, tracks.length, (ppq >> 8) & 255, ppq & 255];
  const total = head.length + tracks.reduce((s, t) => s + t.length, 0), bytes = new Uint8Array(total);
  bytes.set(head, 0);
  let p = head.length;
  for (const t of tracks) { bytes.set(t, p); p += t.length; }
  return { bytes, info: plan.info };
}

// The pitched track: channel 1, the bend range set to ±2 semitones first (RPN 0, the General MIDI
// default, written so no synth has to assume it), each note on and off, and its bend points between.
// A bent note leaves the wheel where it was, so the next note puts it back to the middle first.
function pitchedEvents(notes: readonly PitchedNote[], tickOf: (t: number) => number): MidiEvent[] {
  const ev: MidiEvent[] = [
    { tick: 0, pr: 0, data: metaText(3, 'Notes') },
    { tick: 0, pr: 1, data: [0xb0, 101, 0] }, { tick: 0, pr: 1, data: [0xb0, 100, 0] },
    { tick: 0, pr: 1, data: [0xb0, 6, 2] }, { tick: 0, pr: 1, data: [0xb0, 38, 0] },
  ];
  const wheel = (cents: number) => {
    const v = Math.max(0, Math.min(16383, Math.round(8192 + (cents / 200) * 8192)));
    return [0xe0, v & 127, v >> 7];
  };
  let bent = false;
  for (const n of [...notes].sort((a, b) => a.t - b.t)) {
    const on = tickOf(n.t), off = tickOf(n.end);
    if (on < 0) continue;
    const pitch = Math.max(0, Math.min(127, Math.round(n.pitch))), v = Math.max(1, Math.min(127, Math.round(n.vel)));
    if (bent) { ev.push({ tick: on, pr: 4, data: wheel(0) }); bent = false; }
    ev.push({ tick: on, pr: 5, data: [0x90, pitch, v] }, { tick: Math.max(on + 1, off), pr: 3, data: [0x80, pitch, 0] });
    for (const b of n.bend ?? []) {
      const tick = tickOf(b.t);
      if (tick <= on || tick >= off) continue;
      ev.push({ tick, pr: 6, data: wheel(b.cents) });
      bent = true;
    }
  }
  return ev;
}
