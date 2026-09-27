// How well the spectrogram under the piano roll shows the notes of a whole mix and nothing else, on
// BabySlakh: each song's mix (drums in), against the MIDI of every pitched stem in it. Each view and
// filter set is scored on the semitone cells of the roll (a frame by a semitone, the loudest of its
// three bins): a cell is a note when a stem's MIDI holds that pitch then. Scored three ways:
//
// - AP, average precision: cells ranked by how bright they are drawn, how early the notes come. What
//   the picture shows at every range at once; 100 is every note brighter than anything else.
// - best F: precision and recall at the range that suits the view best, and that range.
// - F at 30 dB, the range the app starts at, and at 60 dB, where it started before.
//
//   SPEC_GRID=bench/grids/spec.json TRACKS=6 npx vitest run --config bench/vitest.config.ts bench/spectrogram.eval.ts
//
// SPEC_GRID lists the configurations ({ name, view, harmonics, filter }); without it, the views as the
// app starts. Writes .dev/eval/spec-<LABEL>.md and .json.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'vitest';
import { type SpecFilter, defaultSpecFilter, postFilter, preFilter } from '../src/core/notes/spec-filter';
import { type PitchSpectrogram, type SpecView, pitchSpectrogram, viewSpectrogram } from '../src/core/notes/spectrogram';
import { type MidiNote, readMidi } from './midi-read';
import { readWav } from './wav-read';

const ROOT = process.env.SLAKH ?? '.dev/babyslakh_16k', LABEL = process.env.LABEL ?? 'current', OUT = process.env.OUT ?? '.dev/eval';
const FIRST = +(process.env.FIRST || 0);

interface Config { name: string; view: SpecView; harmonics: number; filter: Partial<SpecFilter> }
const CONFIGS: Config[] = process.env.SPEC_GRID ? JSON.parse(readFileSync(process.env.SPEC_GRID, 'utf8')) : [
  { name: 'as heard', view: 'audio', harmonics: 8, filter: {} },
  { name: 'fundamentals', view: 'fundamental', harmonics: 8, filter: {} },
  { name: 'harmonics removed', view: 'clean', harmonics: 8, filter: {} },
  { name: 'notes only', view: 'notes', harmonics: 8, filter: {} },
];

// metadata.yaml, as far as the stems go: the pitched ones.
function pitchedStems(track: string): string[] {
  const out: string[] = [];
  let id = '', drum = false;
  const flush = () => { if (id && !drum) out.push(id); };
  for (const line of readFileSync(join(ROOT, track, 'metadata.yaml'), 'utf8').split('\n')) {
    const m = /^ {2}(S\d+):\s*$/.exec(line);
    if (m) { flush(); id = m[1]; drum = false; continue; }
    const kv = /^ {4}is_drum:\s*(\w+)/.exec(line);
    if (kv) drum = kv[1] === 'true';
  }
  flush();
  return out;
}

/** The loudest of a semitone's three bins in a frame. */
const cell = (s: PitchSpectrogram, V: Float32Array, n: number, p: number) => {
  const r = n * s.bins + p * s.perSemitone;
  return Math.max(V[r], V[r + 1], V[r + 2]);
};

/**
 * The octave a stem sounds at against its MIDI (some Slakh patches sound an octave or two off): the
 * shift whose notes stand furthest over the frame's median in the stem's own fundamentals view.
 */
function octaveOf(s: PitchSpectrogram, notes: MidiNote[]): number {
  const V = viewSpectrogram(s, 'fundamental', 8), semis = s.bins / s.perSemitone;
  let best = 0, bs = -Infinity;
  for (const k of [0, -12, 12, -24, 24]) {
    let sum = 0, c = 0;
    for (const nt of notes) {
      const p = nt.pitch + k - s.lo;
      if (p < 0 || p >= semis) continue;
      for (let n = Math.ceil(nt.t * s.fr); n < Math.min(s.frames, nt.end * s.fr); n++) { sum += cell(s, V, n, p); c++; }
    }
    // A shift that leaves most notes off the roll doesn't win on the few left.
    const v = c ? sum / c - (c < 0.5 * notes.length ? 100 : 0) : -Infinity;
    if (v > bs) { bs = v; best = k; }
  }
  return best;
}

interface Tally { ap: number; bestF: number; bestP: number; bestR: number; bestAt: number; f30: number; f60: number; p60: number; r60: number; ms: number }

/** AP, the best F and the F at 60 dB of one view, cells ranked by level. */
function scoreView(s: PitchSpectrogram, V: Float32Array, truth: Uint8Array): Omit<Tally, 'ms'> {
  const semis = s.bins / s.perSemitone, N = s.frames * semis, val = new Float32Array(N);
  let pos = 0;
  for (let n = 0; n < s.frames; n++) for (let p = 0; p < semis; p++) { val[n * semis + p] = cell(s, V, n, p); pos += truth[n * semis + p]; }
  const idx = Array.from({ length: N }, (_, i) => i).filter((i) => val[i] > -120).sort((a, b) => val[b] - val[a]);
  let tp = 0, ap = 0, bestF = 0, bestP = 0, bestR = 0, bestAt = 0, f30 = 0, f60 = 0, p60 = 0, r60 = 0;
  for (let k = 0; k < idx.length; k++) {
    if (truth[idx[k]]) { tp++; ap += tp / (k + 1); }
    // At the end of a run of equal levels: what a range drawing down to this level shows.
    if (k + 1 === idx.length || val[idx[k + 1]] !== val[idx[k]]) {
      const P = tp / (k + 1), R = tp / pos, F = P + R > 0 ? (2 * P * R) / (P + R) : 0;
      if (F > bestF) { bestF = F; bestP = P; bestR = R; bestAt = -val[idx[k]]; }
      if (val[idx[k]] > -60 && (k + 1 === idx.length || val[idx[k + 1]] <= -60)) { f60 = F; p60 = P; r60 = R; }
      if (val[idx[k]] > -30 && (k + 1 === idx.length || val[idx[k + 1]] <= -30)) f30 = F;
    }
  }
  return { ap: pos ? ap / pos : 0, bestF, bestP, bestR, bestAt, f30, f60, p60, r60 };
}

const pct = (v: number) => (100 * v).toFixed(1);

it('shows the notes of BabySlakh mixes', async () => {
  if (!existsSync(ROOT)) { console.warn(`No dataset at ${ROOT}: run bash scripts/fetch_slakh.sh first.`); return; }
  const tracks = readdirSync(ROOT).filter((d) => d.startsWith('Track')).sort().slice(FIRST, FIRST + +(process.env.TRACKS || 99));
  const per: Record<string, Tally[]> = Object.fromEntries(CONFIGS.map((c) => [c.name, []]));
  for (const track of tracks) {
    const mixFile = join(ROOT, track, 'mix.wav');
    if (!existsSync(mixFile)) continue;
    const mix = readWav(readFileSync(mixFile)), s = await pitchSpectrogram(mix.x, mix.sr, { yieldToEventLoop: false });
    const semis = s.bins / s.perSemitone, truth = new Uint8Array(s.frames * semis);
    let stems = 0;
    for (const id of pitchedStems(track)) {
      const wav = join(ROOT, track, 'stems', id + '.wav'), mid = join(ROOT, track, 'MIDI', id + '.mid');
      if (!existsSync(wav) || !existsSync(mid)) continue;
      const notes = readMidi(readFileSync(mid));
      if (!notes.length) continue;
      const a = readWav(readFileSync(wav)), k = octaveOf(await pitchSpectrogram(a.x, a.sr, { yieldToEventLoop: false }), notes);
      stems++;
      for (const nt of notes) {
        const p = nt.pitch + k - s.lo;
        if (p < 0 || p >= semis) continue;
        for (let n = Math.ceil(nt.t * s.fr); n < Math.min(s.frames, nt.end * s.fr); n++) truth[n * semis + p] = 1;
      }
    }
    const pre = new Map<string, PitchSpectrogram>();
    for (const c of CONFIGS) {
      const f = { ...defaultSpecFilter(), ...c.filter }, t0 = performance.now();
      const key = `${f.steady},${f.floor}`;
      if (!pre.has(key)) pre.set(key, preFilter(s, f));
      const P = pre.get(key)!, V = postFilter(P, viewSpectrogram(P, c.view, c.harmonics, f.voices), f);
      const ms = performance.now() - t0, r = scoreView(s, V, truth);
      per[c.name].push({ ...r, ms });
      console.log(`${track} ${stems} stems  ${c.name.padEnd(28)} AP ${pct(r.ap)}  best F ${pct(r.bestF)} (P ${pct(r.bestP)} R ${pct(r.bestR)} at ${r.bestAt.toFixed(0)} dB)  F@60 ${pct(r.f60)}  ${ms.toFixed(0)} ms`);
    }
  }
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  const rows = CONFIGS.map((c) => {
    const t = per[c.name];
    return { name: c.name, view: c.view, harmonics: c.harmonics, filter: c.filter, ap: mean(t.map((x) => x.ap)), bestF: mean(t.map((x) => x.bestF)), bestP: mean(t.map((x) => x.bestP)), bestR: mean(t.map((x) => x.bestR)), bestAt: mean(t.map((x) => x.bestAt)), f30: mean(t.map((x) => x.f30)), f60: mean(t.map((x) => x.f60)), p60: mean(t.map((x) => x.p60)), r60: mean(t.map((x) => x.r60)), ms: mean(t.map((x) => x.ms)) };
  }).sort((a, b) => b.ap - a.ap);
  const lines = [
    `# The spectrogram on BabySlakh mixes: ${LABEL}`, '',
    `${tracks.length} songs, whole mixes with the drums, against every pitched stem's MIDI. Means over the songs.`, '',
    '| configuration | AP | best F | P / R there | at | F at 30 dB | F at 60 dB | P / R at 60 dB | time a song |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map((r) => `| ${r.name} | ${pct(r.ap)} | ${pct(r.bestF)} | ${pct(r.bestP)} / ${pct(r.bestR)} | ${r.bestAt.toFixed(0)} dB | ${pct(r.f30)} | ${pct(r.f60)} | ${pct(r.p60)} / ${pct(r.r60)} | ${r.ms.toFixed(0)} ms |`),
  ];
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, `spec-${LABEL}.md`), lines.join('\n') + '\n');
  writeFileSync(join(OUT, `spec-${LABEL}.json`), JSON.stringify({ label: LABEL, songs: tracks.length, rows }, null, 1) + '\n');
  console.log(lines.join('\n'));
}, 3_600_000);
