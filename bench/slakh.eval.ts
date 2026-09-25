// How well the note detector transcribes real rendered instruments: BabySlakh (Manilow et al., WASPAA
// 2019; https://zenodo.org/records/4603870), the first 20 songs of Slakh2100, each stem rendered from
// MIDI with a sample-based instrument and saved beside that MIDI. Bass stems are read as one line;
// piano, guitar, organ and mallet stems as chords.
//
//   bash scripts/eval_notes.sh [--compare main]   # fetches the dataset the first time; report in .dev/eval/
//
// Not part of `npm test`: it needs the dataset and takes minutes. `scripts/eval_notes.sh` runs it, and
// can run it on another commit beside this one. SLAKH points at another copy of the dataset, LABEL names
// the report, OUT is where it goes (.dev/eval), CLASSES narrows the instrument classes (comma-separated)
// and TRACKS the number of songs. The report is written twice: as Markdown to read, and as JSON for
// `bench/compare.mjs` to set two runs side by side.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'vitest';
import { resample } from '../src/core/dsp/resample';
import { detectNotes } from '../src/core/notes/detect';
import { noNoteEdits, selectNotes } from '../src/core/notes/select';
import type { NoteInstrument, NoteMode } from '../src/core/notes/types';
import { readMidi } from './midi-read';
import { type Score, prf, score, sum } from './score';
import { readWav } from './wav-read';

const ROOT = process.env.SLAKH ?? '.dev/babyslakh_16k', LABEL = process.env.LABEL ?? 'current', OUT = process.env.OUT ?? '.dev/eval';
const MODES: Record<string, NoteMode> = { Bass: 'line', Piano: 'chords', Guitar: 'chords', Organ: 'chords', 'Chromatic Percussion': 'chords' };
// Each chord class is read with its instrument's profile, as a user who knows what the part is would ask.
const INSTRUMENTS: Record<string, NoteInstrument> = { Piano: 'piano', Guitar: 'guitar', Organ: 'organ', 'Chromatic Percussion': 'mallets' };
// Empty is the same as unset: the script passes every option, set or not.
const CLASSES = process.env.CLASSES ? process.env.CLASSES.split(',') : Object.keys(MODES);
const SENS = [30, 55, 80];
// What the app runs at: the browser decodes a file at the audio context's rate.
const SR = 44100;

interface Stem { track: string; id: string; cls: string; program: number }

// metadata.yaml, as far as the stems go: one block per stem, one `key: value` a line.
function stems(track: string): Stem[] {
  const out: Stem[] = [];
  let cur: Record<string, string> | null = null, id = '';
  const flush = () => {
    // BabySlakh's audio_rendered and midi_saved flags don't say which files are there; the files do.
    if (cur && cur.is_drum !== 'true') {
      out.push({ track, id, cls: cur.inst_class, program: +cur.program_num });
    }
  };
  for (const line of readFileSync(join(ROOT, track, 'metadata.yaml'), 'utf8').split('\n')) {
    const m = /^ {2}(S\d+):\s*$/.exec(line);
    if (m) { flush(); cur = {}; id = m[1]; continue; }
    const kv = /^ {4}(\w+):\s*(.*?)\s*$/.exec(line);
    if (cur && kv) cur[kv[1]] = kv[2].replace(/^['"]|['"]$/g, '');
  }
  flush();
  return out;
}

const pct = (v: number) => (100 * v).toFixed(1);
const median = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[a.length >> 1] : NaN);

it('transcribes BabySlakh', async () => {
  if (!existsSync(ROOT)) {
    console.warn(`No dataset at ${ROOT}: run bash scripts/fetch_slakh.sh first.`);
    return;
  }
  const tracks = readdirSync(ROOT).filter((d) => d.startsWith('Track')).sort().slice(0, +(process.env.TRACKS || 99));
  const rows: { stem: Stem; mode: NoteMode; at: Record<number, Score>; ms: number; dur: number; shift: number }[] = [];
  for (const track of tracks) {
    for (const stem of stems(track).filter((s) => CLASSES.includes(s.cls) && MODES[s.cls])) {
      const wav = join(ROOT, track, 'stems', stem.id + '.wav'), mid = join(ROOT, track, 'MIDI', stem.id + '.mid');
      if (!existsSync(wav) || !existsSync(mid)) continue;
      const a = readWav(readFileSync(wav)), truth = readMidi(readFileSync(mid));
      if (!truth.length) continue;
      const x = a.sr === SR ? a.x : resample([a.x], a.sr, SR)[0], mode = MODES[stem.cls];
      const t0 = performance.now(), r = await detectNotes(x, SR, { mode, instrument: INSTRUMENTS[stem.cls] ?? 'any', yieldToEventLoop: false }), ms = performance.now() - t0;
      // Some Slakh patches sound an octave or two from the MIDI they were rendered from (a bass or a
      // guitar written an octave up, as they are notated). That is the patch, not the transcription:
      // each stem is scored at the whole number of octaves its notes match best at.
      const all = selectNotes(r.notes, 100, noNoteEdits());
      const shift = [0, -12, 12, -24, 24].reduce((b, k) => (score(truth.map((n) => ({ ...n, pitch: n.pitch + k })), all).matched > score(truth.map((n) => ({ ...n, pitch: n.pitch + b })), all).matched ? k : b), 0);
      const heard = truth.map((n) => ({ ...n, pitch: n.pitch + shift }));
      const at: Record<number, Score> = {};
      for (const s of SENS) at[s] = score(heard, selectNotes(r.notes, s, noNoteEdits()));
      rows.push({ stem, mode, at, ms, dur: x.length / SR, shift });
      const q = prf(at[55]);
      console.log(`${track} ${stem.id} ${stem.cls.padEnd(20)} ${mode.padEnd(6)} truth ${String(truth.length).padStart(5)} found ${String(at[55].found).padStart(5)}  P ${pct(q.p)} R ${pct(q.r)} F ${pct(q.f)}${shift ? ' (MIDI ' + shift + ')' : ''}`);
    }
  }
  const lines = [
    `# Notes on BabySlakh: ${LABEL}`,
    '',
    `${rows.length} stems from ${tracks.length} songs, at ${SR} Hz. Onset within 50 ms and the same pitch; "F, ends" also needs the end within 20% or 50 ms (mir_eval's note scores). ${rows.filter((r) => r.shift).length} stems sound an octave or more from their MIDI and are scored where they sound (the "MIDI" column).`,
    '',
    '| class | mode | stems | true notes | found at 55 | P | R | F | F, ends | onset error, median | F at 30 / 80 | time per minute |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  const groups = [...new Set(rows.map((r) => r.stem.cls)), 'all chords', 'all'].flatMap((g) => {
    const rs = rows.filter((r) => r.stem.cls === g || g === 'all' || (g === 'all chords' && r.mode === 'chords'));
    if (!rs.length) return [];
    const s55 = sum(rs.map((r) => r.at[55])), q = prf(s55);
    return [{
      name: g, modes: [...new Set(rs.map((r) => r.mode))].join(', '), stems: rs.length, truth: s55.truth, found: s55.found,
      p: q.p, r: q.r, f: q.f, fEnds: q.fEnds, error: median(s55.errors),
      f30: prf(sum(rs.map((r) => r.at[30]))).f, f80: prf(sum(rs.map((r) => r.at[80]))).f,
      perMin: rs.reduce((a, r) => a + r.ms, 0) / 1000 / (rs.reduce((a, r) => a + r.dur, 0) / 60),
    }];
  });
  for (const g of groups) {
    lines.push(`| ${g.name} | ${g.modes} | ${g.stems} | ${g.truth} | ${g.found} | ${pct(g.p)} | ${pct(g.r)} | ${pct(g.f)} | ${pct(g.fEnds)} | ${g.error.toFixed(1)} ms | ${pct(g.f30)} / ${pct(g.f80)} | ${g.perMin.toFixed(1)} s |`);
  }
  lines.push('', '| stem | class | mode | MIDI | true | found | P | R | F | F, ends |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  const stemRows = rows.map((r) => {
    const q = prf(r.at[55]);
    return { stem: `${r.stem.track}/${r.stem.id}`, cls: r.stem.cls, mode: r.mode, shift: r.shift, truth: r.at[55].truth, found: r.at[55].found, p: q.p, r: q.r, f: q.f, fEnds: q.fEnds };
  });
  for (const r of stemRows) {
    lines.push(`| ${r.stem} | ${r.cls} | ${r.mode} | ${r.shift ? (r.shift > 0 ? '+' : '') + r.shift : ''} | ${r.truth} | ${r.found} | ${pct(r.p)} | ${pct(r.r)} | ${pct(r.f)} | ${pct(r.fEnds)} |`);
  }
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, `notes-${LABEL}.md`), lines.join('\n') + '\n');
  writeFileSync(join(OUT, `notes-${LABEL}.json`), JSON.stringify({ label: LABEL, songs: tracks.length, shifted: rows.filter((r) => r.shift).length, groups, stems: stemRows }, null, 1) + '\n');
  console.log(lines.slice(0, 6 + groups.length).join('\n'));
}, 3_600_000);
