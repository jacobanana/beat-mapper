// The chord detector's tuning harness: many parameter sets scored on one half of BabySlakh, so a
// profile is chosen on songs it is then not tested on. The odd-numbered songs are for choosing (SPLIT=
// train), the even-numbered for the test (SPLIT=test); `bench/tune-report.mjs` reads what this writes.
//
//   GRID=grid.json SPLIT=train LABEL=round1 npx vitest run --config bench/vitest.config.ts bench/tune.eval.ts
//
// GRID is a JSON file, `{ "configs": [{ "name": ..., "params": { ...ChordParams overrides } }] }`.
// The stages that a set of parameters doesn't change are shared: the spectrogram once a stem, the
// factorisation once per distinct set of its parameters, the onsets likewise. SHARD=i/n takes every
// n-th stem from the i-th, so n processes can share the work. With DIAG=1 the first config's notes
// and the truth are written out for `bench/tune-report.mjs --diag` to sort the errors.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'vitest';
import { resample } from '../src/core/dsp/resample';
import { CHORD_DEFAULTS, type ChordParams, chordActivations, chordInput, chordNotes, chordOnsets } from '../src/core/notes/chords';
import { noNoteEdits, selectNotes } from '../src/core/notes/select';
import type { Note } from '../src/core/notes/types';
import { readMidi } from './midi-read';
import { type Score, score } from './score';
import { readWav } from './wav-read';

const ROOT = process.env.SLAKH ?? '.dev/babyslakh_16k', LABEL = process.env.LABEL ?? 'tune', OUT = process.env.OUT ?? '.dev/eval';
const CHORD_CLASSES = ['Piano', 'Guitar', 'Organ', 'Chromatic Percussion'];
const CLASSES = process.env.CLASSES ? process.env.CLASSES.split(',') : CHORD_CLASSES;
const SPLIT = process.env.SPLIT ?? 'train';
const [SHARD_I, SHARD_N] = (process.env.SHARD ?? '0/1').split('/').map(Number);
const SENS = [30, 55, 80];
const SR = 44100;

interface Config { name: string; params: Partial<ChordParams> }
interface Stem { track: string; id: string; cls: string; program: number }

function stems(track: string): Stem[] {
  const out: Stem[] = [];
  let cur: Record<string, string> | null = null, id = '';
  const flush = () => { if (cur && cur.is_drum !== 'true') out.push({ track, id, cls: cur.inst_class, program: +cur.program_num }); };
  for (const line of readFileSync(join(ROOT, track, 'metadata.yaml'), 'utf8').split('\n')) {
    const m = /^ {2}(S\d+):\s*$/.exec(line);
    if (m) { flush(); cur = {}; id = m[1]; continue; }
    const kv = /^ {4}(\w+):\s*(.*?)\s*$/.exec(line);
    if (cur && kv) cur[kv[1]] = kv[2].replace(/^['"]|['"]$/g, '');
  }
  flush();
  return out;
}

const ACT_KEYS: (keyof ChordParams)[] = ['lo', 'hi', 'decay', 'partials', 'inharmonicity', 'iterations', 'beta', 'adapt', 'sparsity', 'floor'];
const ONS_KEYS: (keyof ChordParams)[] = ['onsetThreshold', 'onsetPeakWindow', 'onsetMeanWindow', 'onsetLag'];
const keyOf = (p: ChordParams, keys: (keyof ChordParams)[]) => JSON.stringify(keys.map((k) => p[k]));

/** The song's number: odd ones tune, even ones test. */
const inSplit = (track: string) => SPLIT === 'all' || (+track.replace(/\D/g, '') % 2 === 1) === (SPLIT === 'train');

it('tunes the chord detector on BabySlakh', async () => {
  const grid: { configs: Config[] } = JSON.parse(readFileSync(process.env.GRID ?? 'bench/grids/defaults.json', 'utf8'));
  const tracks = readdirSync(ROOT).filter((d) => d.startsWith('Track')).sort().slice(0, +(process.env.TRACKS || 99)).filter(inSplit);
  const all: Stem[] = tracks.flatMap((t) => stems(t).filter((s) => CLASSES.includes(s.cls) && CHORD_CLASSES.includes(s.cls)));
  const mine = all.filter((_, i) => i % SHARD_N === SHARD_I);
  const rows: { stem: string; cls: string; program: number; config: string; shift: number; at: Record<number, Score>; ms: number; dur: number }[] = [];
  const diag: { stem: string; cls: string; shift: number; onsets: number[]; truth: { pitch: number; t: number; end: number; vel: number }[]; found: Note[] }[] = [];
  for (const stem of mine) {
    const wav = join(ROOT, stem.track, 'stems', stem.id + '.wav'), mid = join(ROOT, stem.track, 'MIDI', stem.id + '.mid');
    if (!existsSync(wav) || !existsSync(mid)) continue;
    const a = readWav(readFileSync(wav)), truth = readMidi(readFileSync(mid));
    if (!truth.length) continue;
    const x = a.sr === SR ? a.x : resample([a.x], a.sr, SR)[0], name = `${stem.track}/${stem.id}`;
    const t0 = performance.now(), inp = await chordInput(x, SR, { yieldToEventLoop: false }), tIn = performance.now() - t0;
    const acts = new Map<string, Float32Array>(), onsets = new Map<string, number[]>();
    let line = `${name} ${stem.cls.padEnd(20)} in ${tIn.toFixed(0)} ms`;
    for (const c of grid.configs) {
      const p: ChordParams = { ...CHORD_DEFAULTS, ...c.params }, t1 = performance.now();
      const ak = keyOf(p, ACT_KEYS), ok = keyOf(p, ONS_KEYS);
      let H = acts.get(ak);
      if (!H) { H = await chordActivations(inp, p, { yieldToEventLoop: false }); acts.set(ak, H); }
      let ons = onsets.get(ok);
      if (!ons) { ons = chordOnsets(inp, p); onsets.set(ok, ons); }
      const notes = chordNotes(inp, H, ons, p), ms = performance.now() - t1;
      const all = selectNotes(notes, 100, noNoteEdits());
      const shift = [0, -12, 12, -24, 24].reduce((b, k) => (score(truth.map((n) => ({ ...n, pitch: n.pitch + k })), all).matched > score(truth.map((n) => ({ ...n, pitch: n.pitch + b })), all).matched ? k : b), 0);
      const heard = truth.map((n) => ({ ...n, pitch: n.pitch + shift }));
      const at: Record<number, Score> = {};
      for (const s of SENS) at[s] = score(heard, selectNotes(notes, s, noNoteEdits()));
      rows.push({ stem: name, cls: stem.cls, program: stem.program, config: c.name, shift, at, ms, dur: x.length / SR });
      const q = at[55];
      line += `  ${c.name}: ${(200 * q.matched / Math.max(1, q.truth + q.found)).toFixed(1)}`;
      if (process.env.DIAG && c === grid.configs[0]) diag.push({ stem: name, cls: stem.cls, shift, onsets: ons, truth: heard, found: selectNotes(notes, 55, noNoteEdits()) });
    }
    console.log(line);
  }
  mkdirSync(OUT, { recursive: true });
  const suffix = SHARD_N > 1 ? `-${SHARD_I}of${SHARD_N}` : '';
  writeFileSync(join(OUT, `tune-${LABEL}${suffix}.json`), JSON.stringify({ label: LABEL, split: SPLIT, configs: grid.configs, rows }) + '\n');
  if (process.env.DIAG) writeFileSync(join(OUT, `diag-${LABEL}${suffix}.json`), JSON.stringify(diag) + '\n');
}, 36_000_000);
