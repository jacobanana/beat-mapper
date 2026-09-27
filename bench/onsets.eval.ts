// How well the transient markers land on BabySlakh: every stem (drums too) and every song's mix,
// scored against the onsets of the MIDI it was rendered from. A marker counts when it is within 50 ms
// of a true onset, each onset matched once, and onsets closer than 30 ms (a chord's notes) are one.
// Every detection function is scored at sensitivities 40, 55 and 70 with the starting gap, full band.
//
//   npx vitest run --config bench/vitest.config.ts bench/onsets.eval.ts     # after scripts/fetch_slakh.sh
//
// SLAKH points at another copy of the dataset, TRACKS takes the first n songs, ALGOS the detection
// functions (comma-separated), SPLIT=train|test the odd- or even-numbered songs, LABEL names the report
// (.dev/eval/onsets-<label>.md).
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'vitest';
import { type Algo, analyze } from '../src/core/dsp/onset';
import { resample } from '../src/core/dsp/resample';
import { detectMarkers, pickCandidates, sensToThr } from '../src/core/markers/detect';
import { readMidi } from './midi-read';
import { readWav } from './wav-read';

const ROOT = process.env.SLAKH ?? '.dev/babyslakh_16k', LABEL = process.env.LABEL ?? 'current', OUT = process.env.OUT ?? '.dev/eval';
const ALGOS = (process.env.ALGOS ?? 'flux,superflux').split(',') as Algo[];
const SPLIT = process.env.SPLIT ?? 'all';
const SENS = [40, 55, 70];
const SR = 44100;

interface Count { tp: number; fp: number; fn: number }
const F = (c: Count) => (2 * c.tp) / Math.max(1, 2 * c.tp + c.fp + c.fn);
const pct = (v: number) => (100 * v).toFixed(1);

// One onset for notes that start within 30 ms of each other.
function merge(ts: number[]): number[] {
  const out: number[] = [];
  for (const t of [...ts].sort((a, b) => a - b)) if (!out.length || t - out[out.length - 1] > 0.03) out.push(t);
  return out;
}

// Closest pairs first, each onset and each marker used once.
function count(found: number[], truth: number[]): Count {
  const pairs: [number, number, number][] = [];
  let lo = 0;
  found.forEach((f, j) => {
    while (lo < truth.length && truth[lo] < f - 0.05) lo++;
    for (let i = lo; i < truth.length && truth[i] <= f + 0.05; i++) pairs.push([Math.abs(truth[i] - f), i, j]);
  });
  pairs.sort((a, b) => a[0] - b[0]);
  const ti = new Set<number>(), fj = new Set<number>();
  for (const [, i, j] of pairs) if (!ti.has(i) && !fj.has(j)) { ti.add(i); fj.add(j); }
  return { tp: ti.size, fp: found.length - ti.size, fn: truth.length - ti.size };
}

// metadata.yaml, as far as the stems go: each stem's class, and whether it is the drums.
function stems(track: string): { id: string; cls: string }[] {
  return readFileSync(join(ROOT, track, 'metadata.yaml'), 'utf8').split(/\n {2}(?=S\d+:)/).flatMap((b) => {
    const id = /^(S\d+):/.exec(b)?.[1], cls = /\n {4}inst_class:\s*['"]?([^'"\n]+)/.exec(b)?.[1];
    return id && cls ? [{ id, cls: /\n {4}is_drum:\s*true/.test(b) ? 'Drums' : cls.trim() }] : [];
  });
}

const load = (path: string) => { const a = readWav(readFileSync(path)); return a.sr === SR ? a.x : resample([a.x], a.sr, SR)[0]; };

it('marks the onsets of BabySlakh', async () => {
  if (!existsSync(ROOT)) {
    console.warn(`No dataset at ${ROOT}: run bash scripts/fetch_slakh.sh first.`);
    return;
  }
  const tracks = readdirSync(ROOT).filter((d) => d.startsWith('Track')).sort().slice(0, +(process.env.TRACKS || 99))
    .filter((t) => SPLIT === 'all' || (+t.replace(/\D/g, '') % 2 === 1) === (SPLIT === 'train'));
  const byClass = new Map<string, Record<string, Count[]>>();
  const add = (cls: string, algo: string, i: number, c: Count) => {
    const g = byClass.get(cls) ?? {}, a = (g[algo] ??= SENS.map(() => ({ tp: 0, fp: 0, fn: 0 })));
    a[i].tp += c.tp; a[i].fp += c.fp; a[i].fn += c.fn;
    byClass.set(cls, g);
  };
  const score = async (x: Float32Array, truth: number[], cls: string) => {
    const an = await analyze(x, SR, { yieldToEventLoop: false });
    for (const algo of ALGOS) {
      const cands = pickCandidates(an, 'full', x, SR, algo);
      SENS.forEach((s, i) => add(cls, algo, i, count(detectMarkers(cands, sensToThr(s), 0.06).map((k) => cands[k].t), truth)));
    }
  };
  let n = 0;
  for (const track of tracks) {
    const every: number[] = [];
    for (const st of stems(track)) {
      const wav = join(ROOT, track, 'stems', st.id + '.wav'), mid = join(ROOT, track, 'MIDI', st.id + '.mid');
      if (!existsSync(wav) || !existsSync(mid)) continue;
      const on = readMidi(readFileSync(mid)).map((k) => k.t);
      if (!on.length) continue;
      every.push(...on);
      const x = load(wav);
      await score(x, merge(on).filter((t) => t < x.length / SR - 0.05), st.cls);
      n++;
    }
    const mix = join(ROOT, track, 'mix.wav');
    if (existsSync(mix) && every.length) { const x = load(mix); await score(x, merge(every).filter((t) => t < x.length / SR - 0.05), 'full mix'); }
    console.log(`${track} done`);
  }
  const head = `| class | ${ALGOS.map((a) => `${a}: F at 40 / 55 / 70 | false, missed at 55`).join(' | ')} |`;
  const lines = [
    `# Transient markers on BabySlakh: ${LABEL}`, '',
    `${n} stems and ${tracks.length} mixes. A marker within 50 ms of a MIDI onset counts; onsets within 30 ms of each other are one.`, '',
    head, `| --- |${ALGOS.map(() => ' --- | --- |').join('')}`,
  ];
  const row = (name: string, g: Record<string, Count[]>) =>
    `| ${name} | ${ALGOS.map((a) => `${g[a].map(F).map(pct).join(' / ')} | ${g[a][1].fp}, ${g[a][1].fn}`).join(' | ')} |`;
  const classes = [...byClass.keys()].sort();
  for (const c of classes) lines.push(row(c, byClass.get(c)!));
  // Every class counted once: a class with many onsets (drums) doesn't outweigh the rest.
  lines.push(`| mean of classes | ${ALGOS.map((a) => `${SENS.map((_, i) => pct(classes.reduce((s, c) => s + F(byClass.get(c)![a][i]), 0) / classes.length)).join(' / ')} | |`).join(' | ')} |`);
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, `onsets-${LABEL}.md`), lines.join('\n') + '\n');
  console.log(lines.join('\n'));
}, 36_000_000);
