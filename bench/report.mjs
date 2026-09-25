// The benchmark's report: one run of bench/slakh.eval.ts, or two side by side. Reads the JSON each run
// writes and prints Markdown.
//
//   node bench/report.mjs <run.json> [<base.json>] [--title <text>] [--note <line>]...
//
// With a base, each class gets its F-measure before and after, and the stems that moved most are
// listed: an average hides a change that fixes one instrument and breaks another.
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2), files = [], notes = [];
let title = 'Notes benchmark on BabySlakh';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--title') title = args[++i];
  else if (args[i] === '--note') notes.push(args[++i]);
  else files.push(args[i]);
}
if (!files.length) {
  console.error('usage: node bench/report.mjs <run.json> [<base.json>] [--title <text>] [--note <line>]...');
  process.exit(2);
}
const [run, base] = files.map((f) => JSON.parse(readFileSync(f, 'utf8')));
const pct = (v) => (100 * v).toFixed(1);
const delta = (a, b) => { const d = 100 * (a - b); return (d >= 0 ? '+' : '−') + Math.abs(d).toFixed(1); };
const out = [`# ${title}`, ''];
for (const n of notes) out.push(n);
if (notes.length) out.push('');
out.push(
  `${run.stems.length} stems from ${run.songs} songs. A note is right when its pitch is and it starts within 50 ms of the true one; ` +
  `"F, ends" also needs it to end within 20% of its length or 50 ms (mir_eval's note scores). All at the starting sensitivity, 55. ` +
  `${run.shifted} stems sound an octave or more from their MIDI and are scored where they sound.`,
  '',
);

if (base) {
  const bg = new Map(base.groups.map((g) => [g.name, g]));
  out.push(
    `| class | mode | stems | F, ${base.label} | F, ${run.label} | change | precision | recall | F, ends | onset error | time per minute |`,
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  );
  for (const g of run.groups) {
    const b = bg.get(g.name);
    out.push(`| ${g.name} | ${g.modes} | ${g.stems} | ${b ? pct(b.f) : '–'} | **${pct(g.f)}** | ${b ? delta(g.f, b.f) : '–'} | ${pct(g.p)}${b ? ` (${delta(g.p, b.p)})` : ''} | ${pct(g.r)}${b ? ` (${delta(g.r, b.r)})` : ''} | ${pct(g.fEnds)}${b ? ` (${delta(g.fEnds, b.fEnds)})` : ''} | ${g.error.toFixed(1)} ms | ${g.perMin.toFixed(1)} s${b ? ` (was ${b.perMin.toFixed(1)})` : ''} |`);
  }
  const bs = new Map(base.stems.map((s) => [s.stem, s]));
  const moved = run.stems.filter((s) => bs.has(s.stem)).map((s) => ({ ...s, d: s.f - bs.get(s.stem).f, was: bs.get(s.stem).f }));
  const list = (rows, head) => {
    if (!rows.length) return;
    out.push('', `**${head}**`, '', `| stem | class | F, ${base.label} | F, ${run.label} | change |`, '| --- | --- | --- | --- | --- |');
    for (const s of rows) out.push(`| ${s.stem} | ${s.cls} | ${pct(s.was)} | ${pct(s.f)} | ${delta(s.f, s.was)} |`);
  };
  list(moved.filter((s) => s.d > 0.005).sort((a, b) => b.d - a.d).slice(0, 8), 'Most improved');
  list(moved.filter((s) => s.d < -0.005).sort((a, b) => a.d - b.d).slice(0, 8), 'Most worse');
  if (!moved.some((s) => Math.abs(s.d) > 0.005)) out.push('', 'No stem moved by more than half a point.');
} else {
  out.push(
    '| class | mode | stems | true notes | found | precision | recall | F | F, ends | onset error | F at 30 / 80 | time per minute |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  );
  for (const g of run.groups) {
    out.push(`| ${g.name} | ${g.modes} | ${g.stems} | ${g.truth} | ${g.found} | ${pct(g.p)} | ${pct(g.r)} | **${pct(g.f)}** | ${pct(g.fEnds)} | ${g.error.toFixed(1)} ms | ${pct(g.f30)} / ${pct(g.f80)} | ${g.perMin.toFixed(1)} s |`);
  }
}
out.push('', `The scores of every stem are in notes-${run.label}.md${base ? ` and notes-${base.label}.md` : ''}, beside this report.`);
console.log(out.join('\n'));
