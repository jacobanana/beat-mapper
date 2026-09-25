// What the tuning harness found: for every config, F per class and overall on the stems of a run, or
// with --diag, what kind of errors the first config makes.
//
//   node bench/tune-report.mjs .dev/eval/tune-round1*.json [--sens 55] [--by class|stem] [--top 12]
//   node bench/tune-report.mjs --diag .dev/eval/diag-round1*.json
//
// F here is pooled over the stems of a class, as bench/slakh.eval.ts pools it.
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2), files = [];
let sens = 55, by = 'class', top = 12, diag = false, only = '';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--sens') sens = +args[++i];
  else if (args[i] === '--by') by = args[++i];
  else if (args[i] === '--top') top = +args[++i];
  else if (args[i] === '--class') only = args[++i];
  else if (args[i] === '--diag') diag = true;
  else files.push(args[i]);
}
const pct = (v) => (100 * v).toFixed(1);
const prf = (s) => { const p = s.found ? s.matched / s.found : 0, r = s.truth ? s.matched / s.truth : 0; return { p, r, f: p + r ? (2 * p * r) / (p + r) : 0, fe: s.found + s.truth ? (2 * s.matchedEnds) / (s.found + s.truth) : 0 }; };

if (diag) {
  // Each found note not matched: what it is next to in the truth. Each true note not found: whether
  // anything was found at its onset at all.
  const stems = files.flatMap((f) => JSON.parse(readFileSync(f, 'utf8')));
  const kinds = {};
  const add = (cls, k) => { (kinds[cls] ??= {})[k] = ((kinds[cls] ??= {})[k] ?? 0) + 1; kinds.all ??= {}; kinds.all[k] = (kinds.all[k] ?? 0) + 1; };
  for (const s of stems) {
    if (only && s.cls !== only) continue;
    const truth = s.truth, found = s.found;
    // Match as the score does: closest onsets first.
    const cand = [];
    truth.forEach((n, i) => found.forEach((m, j) => { const d = Math.abs(m.t - n.t); if (m.pitch === n.pitch && d <= 0.05) cand.push([d, i, j]); }));
    cand.sort((a, b) => a[0] - b[0]);
    const ti = new Set(), fj = new Set();
    for (const [, i, j] of cand) if (!ti.has(i) && !fj.has(j)) { ti.add(i); fj.add(j); }
    const near = (t, w) => truth.filter((n) => Math.abs(n.t - t) <= w);
    found.forEach((m, j) => {
      if (fj.has(j)) { add(s.cls, 'FP/–'); return; }
      const same = near(m.t, 0.05);
      let k = 'FP spurious';
      if (truth.some((n) => n.pitch === m.pitch && Math.abs(n.t - m.t) <= 0.15)) k = 'FP late/early (50–150 ms)';
      else if (truth.some((n) => n.pitch === m.pitch && n.t < m.t - 0.05 && n.end > m.t)) k = 'FP held note retriggered';
      else if (same.some((n) => [12, 19, 24, 28, 31, 34, 36].includes(m.pitch - n.pitch))) k = 'FP partial of a chord note';
      else if (same.some((n) => Math.abs(m.pitch - n.pitch) === 12)) k = 'FP octave under';
      else if (same.some((n) => Math.abs(m.pitch - n.pitch) <= 2)) k = 'FP neighbour of a chord note';
      else if (same.length) k = 'FP other pitch at a true onset';
      else if (truth.some((n) => n.t < m.t && n.end > m.t && [12, 19, 24, 28, 31, 34, 36, 0, 1, 2, -1, -2].includes(m.pitch - n.pitch))) k = 'FP on a held note (no onset)';
      add(s.cls, k);
      // The interval to the true notes sounding then, for the histogram: what a wrong pitch tends to be.
      const sounding = truth.filter((n) => n.t - 0.05 <= m.t && n.end >= m.t);
      if (!fj.has(j)) for (const n of sounding) add(s.cls, `FPi ${m.pitch - n.pitch}`);
    });
    truth.forEach((n, i) => {
      if (ti.has(i)) { add(s.cls, 'FN/–'); return; }
      const anyFound = found.some((m) => Math.abs(m.t - n.t) <= 0.05);
      const sameLater = found.some((m) => m.pitch === n.pitch && Math.abs(m.t - n.t) <= 0.15);
      const dur = n.end - n.t;
      let k = 'FN nothing at its onset';
      if (s.onsets && !s.onsets.some((t) => Math.abs(t - n.t) <= 0.05)) k = 'FN no onset found';
      else if (sameLater) k = 'FN found off by 50–150 ms';
      else if (anyFound && found.some((m) => Math.abs(m.t - n.t) <= 0.05 && Math.abs(m.pitch - n.pitch) === 12)) k = 'FN found an octave off';
      else if (anyFound) k = 'FN chord found, this pitch missed';
      else if (truth.some((m) => m !== n && m.pitch === n.pitch && m.end > n.t - 0.02 && m.t < n.t)) k = 'FN repeat of a ringing pitch, nothing found';
      if (dur < 0.08 && k.startsWith('FN')) k += ' (short)';
      if (n.vel < 40 && k.startsWith('FN')) k += ' (soft)';
      add(s.cls, k);
    });
  }
  for (const cls of Object.keys(kinds)) {
    const ks = kinds[cls], fp = Object.entries(ks).filter(([k]) => k.startsWith('FP') && !k.startsWith('FPi')).sort((a, b) => b[1] - a[1]);
    const fn = Object.entries(ks).filter(([k]) => k.startsWith('FN')).sort((a, b) => b[1] - a[1]);
    const nf = fp.reduce((a, [, v]) => a + v, 0), nt = fn.reduce((a, [, v]) => a + v, 0);
    console.log(`\n## ${cls}: ${nf} found, ${nt} true\n`);
    for (const [k, v] of fp) console.log(`  ${k.padEnd(40)} ${String(v).padStart(6)}  ${pct(v / nf)}%`);
    for (const [k, v] of fn) console.log(`  ${k.padEnd(40)} ${String(v).padStart(6)}  ${pct(v / nt)}%`);
    const iv = Object.entries(ks).filter(([k]) => k.startsWith('FPi')).sort((a, b) => b[1] - a[1]).slice(0, 14);
    console.log('  wrong pitch, interval to a sounding true note: ' + iv.map(([k, v]) => `${k.slice(4)}:${v}`).join(' '));
  }
  process.exit(0);
}

const rows = files.flatMap((f) => JSON.parse(readFileSync(f, 'utf8')).rows);
const configs = [...new Set(rows.map((r) => r.config))], classes = [...new Set(rows.map((r) => r.cls))];
const pool = (rs) => rs.reduce((a, r) => ({ truth: a.truth + r.at[sens].truth, found: a.found + r.at[sens].found, matched: a.matched + r.at[sens].matched, matchedEnds: a.matchedEnds + r.at[sens].matchedEnds }), { truth: 0, found: 0, matched: 0, matchedEnds: 0 });
if (by === 'stem') {
  const stems = [...new Set(rows.map((r) => r.stem))];
  console.log(['stem', 'class', ...configs].join(' | '));
  for (const s of stems) console.log([s, rows.find((r) => r.stem === s).cls, ...configs.map((c) => { const r = rows.find((q) => q.stem === s && q.config === c); return r ? pct(prf(r.at[sens]).f) : '–'; })].join(' | '));
  process.exit(0);
}
const groups = [...classes, 'all chords'];
const table = configs.map((c) => {
  const rs = rows.filter((r) => r.config === c), out = { config: c, ms: rs.reduce((a, r) => a + r.ms, 0) / 1000 / (rs.reduce((a, r) => a + r.dur, 0) / 60) };
  for (const g of groups) { const q = prf(pool(rs.filter((r) => g === 'all chords' || r.cls === g))); out[g] = q; }
  return out;
});
const key = only || 'all chords';
table.sort((a, b) => b[key].f - a[key].f);
console.log(`stems: ${[...new Set(rows.map((r) => r.stem))].length}, sens ${sens}, sorted by F on ${key}\n`);
console.log(['config'.padEnd(28), ...groups.map((g) => g.slice(0, 9).padStart(9)), '  P/R/Fends(all)', ' s/min'].join(' '));
for (const t of table.slice(0, top)) console.log([t.config.padEnd(28), ...groups.map((g) => pct(t[g].f).padStart(9)), `  ${pct(t['all chords'].p)}/${pct(t['all chords'].r)}/${pct(t['all chords'].fe)}`, t.ms.toFixed(1).padStart(6)].join(' '));
