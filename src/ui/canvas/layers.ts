// The editor canvas, one function per layer, drawn back to front. Each reads the app state and
// draws; none of them changes anything.
import type { App } from '../../app/app';
import { lowerBound } from '../../core/search';
import { odfOf, odfRef } from '../../core/dsp/onset';
import { type Layout, LOOPH, RUL, RULH, TIME } from './layout';
import { type Colors, FONT, rgba } from './theme';

export interface Frame {
  g: CanvasRenderingContext2D;
  app: App;
  L: Layout;
  C: Colors;
  xOf: (t: number) => number;
  /** Beats and later: markers recede. */
  beatsMode: boolean;
  /** Steps 1 and 2 have an edit half. */
  editable: boolean;
}

export function background({ g, L, C, editable }: Frame): void {
  const { w, wy, ly, ty, ey, laneH } = L;
  g.fillStyle = C.panel;
  g.fillRect(0, 0, w, RUL);
  g.fillRect(0, ly, w, laneH + TIME);
  g.strokeStyle = C.line; g.lineWidth = 1; g.beginPath();
  g.moveTo(0, wy + 0.5); g.lineTo(w, wy + 0.5); g.moveTo(0, ly + 0.5); g.lineTo(w, ly + 0.5); g.moveTo(0, ty + 0.5); g.lineTo(w, ty + 0.5);
  g.stroke();
  if (editable) { g.fillStyle = rgba(C.ink, 0.075); g.fillRect(0, wy + 1, w, ey - wy - 1); }
  g.fillStyle = C.stage; g.fillRect(0, 0, w, LOOPH);
  g.strokeStyle = C.line; g.beginPath(); g.moveTo(0, LOOPH + 0.5); g.lineTo(w, LOOPH + 0.5); g.stroke();
}

/** Bar, beat and subdivision lines with their numbers, and the lead-in before bar 1. Returns the finest level shown. */
export function grid({ g, app, L, C, xOf }: Frame): 0 | 1 | 2 {
  const { w, wy, wh, ly, ty } = L, v = app.view, map = app.tempoMap, grid = app.grid;
  const q0 = map.timeToPos(v.t0), q1 = map.timeToPos(v.t1), pxQ = w / (q1 - q0), bq = grid.barQ, gq = grid.stepQ, btq = grid.beatQ;
  const gridHasBeats = gq <= btq + 1e-9;
  const showSub = gq * pxQ >= 7, showBeat = (gridHasBeats ? btq : gq) * pxQ >= 7, visLevel = showSub ? 2 : showBeat ? 1 : 0;
  let stride = 1;
  while (bq * stride * pxQ < 5) stride *= 2;
  let labStride = stride;
  while (bq * labStride * pxQ < 34) labStride *= 2;
  const a = app.step === 2 ? 1 : 0.45;
  g.font = '500 12px ' + FONT;
  g.textBaseline = 'middle';
  for (let b = Math.floor(q0 / bq) - 1; b <= Math.floor(q1 / bq) + 1; b++) {
    if (((b % stride) + stride) % stride) continue;
    for (let j = 0; j * gq < bq - 1e-9; j++) {
      const lv = grid.level(j);
      if (lv > visLevel) continue;
      if (!gridHasBeats && j > 0 && !showBeat) continue;
      const q = b * bq + j * gq, x = Math.round(xOf(map.posToTime(q))) + 0.5;
      if (x < -2 || x > w + 2) continue;
      g.strokeStyle = rgba(C.beat, (lv === 0 ? 0.75 : lv === 1 ? 0.4 : 0.18) * a * (q < 0 ? 0.5 : 1));
      g.beginPath(); g.moveTo(x, lv === 0 ? LOOPH + 3 : wy); g.lineTo(x, lv === 0 ? ty : ly); g.stroke();
      if (lv === 0 && b >= 0 && !(b % labStride)) { g.fillStyle = rgba(C.ink, app.step === 2 ? 0.95 : 0.55); g.fillText(String(b + 1), x + 9, LOOPH + RULH / 2 + 1); }
      else if (lv === 1 && btq * pxQ >= 44 && q >= 0) { g.fillStyle = rgba(C.dim, 0.9); g.fillText(b + 1 + '.' + (Math.round((j * gq) / btq) + 1), x + 9, LOOPH + RULH / 2 + 1); }
    }
  }
  // lead-in shade
  const A = map.anchors, xd = xOf(A[0].q === 0 ? A[0].t : map.posToTime(0));
  if (xd > 0) {
    g.fillStyle = rgba(C.stage, 0.55); g.fillRect(0, wy + 1, Math.min(w, xd), wh - 1);
    if (xd > 60 && app.step === 2) { g.fillStyle = C.dim; g.font = '13px ' + FONT; g.fillText('lead-in', 6, wy + 12); }
  }
  return visLevel;
}

// Transientness: the detection function the markers come from, rising from the bottom of the wave
// area. Full height is its 99th percentile. Zoomed out, each pixel shows the loudest frame it covers.
export function odf({ g, app, L, C, xOf, beatsMode }: Frame): void {
  const an = app.analysis, a = app.audio;
  if (!app.detection.showOdf || !an || !a || app.step === 5) return;
  const { w, wh, ly } = L, v = app.view, { algo, band } = app.detection;
  const f = odfOf(an, algo, band), ref = odfRef(an, algo, band), dt = an.hop / a.sr, tf = (0.6 * an.N - an.pad) / a.sr, span = v.span, hh = wh - 4;
  const pts: number[] = [];
  if (span / dt > w) {
    for (let px = 0; px < w; px++) {
      const i0 = Math.max(0, Math.ceil((v.t0 + (span * px) / w - tf) / dt)), i1 = Math.min(f.length, Math.ceil((v.t0 + (span * (px + 1)) / w - tf) / dt));
      let m = 0;
      for (let n = i0; n < i1; n++) if (f[n] > m) m = f[n];
      pts.push(px, ly - Math.min(1, m / ref) * hh);
    }
  } else {
    const n0 = Math.max(0, Math.floor((v.t0 - tf) / dt) - 1), n1 = Math.min(f.length - 1, Math.ceil((v.t1 - tf) / dt) + 1);
    for (let n = n0; n <= n1; n++) pts.push(xOf(tf + n * dt), ly - Math.min(1, f[n] / ref) * hh);
  }
  if (!pts.length) return;
  g.beginPath(); g.moveTo(pts[0], ly);
  for (let i = 0; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]);
  g.lineTo(pts[pts.length - 2], ly); g.closePath();
  g.fillStyle = rgba(C.mark, beatsMode ? 0.07 : 0.14); g.fill();
  g.beginPath();
  for (let i = 0; i < pts.length; i += 2) if (i) g.lineTo(pts[i], pts[i + 1]); else g.moveTo(pts[i], pts[i + 1]);
  g.strokeStyle = rgba(C.mark, beatsMode ? 0.3 : 0.6); g.lineWidth = 1; g.stroke();
}

/** Slices: every kept region shaded, the selected one brightest, dropped ones greyed out. */
export function slices({ g, app, L, C, xOf }: Frame): void {
  const S = app.slices;
  if (app.step !== 4 || !S.length) return;
  const { wy, ly } = L, v = app.view, yb = wy + 1, hg = ly - wy - 1, selI = app.sliceIndex;
  g.font = '500 12px ' + FONT; g.textBaseline = 'middle';
  for (const sl of S) {
    if (sl.t1 < v.t0 || sl.t0 > v.t1) continue;
    const x0 = xOf(sl.t0), x1 = xOf(sl.t1), sw = x1 - x0, sel = sl.i === selI;
    if (sw >= 14 || sel || sl.off) { g.fillStyle = sl.off ? rgba(C.dim, 0.12) : rgba(C.slice, sel ? 0.24 : sl.i & 1 ? 0.11 : 0.04); g.fillRect(x0, yb, Math.max(1, sw), hg); }
    g.strokeStyle = rgba(C.slice, sl.off ? 0.25 : sel ? 1 : sw < 14 ? 0.45 : 0.7); g.lineWidth = sel ? 2 : 1;
    g.beginPath(); const xs = Math.round(x0) + 0.5; g.moveTo(xs, yb); g.lineTo(xs, ly); g.stroke();
    if (sw >= 26 || (sel && sw >= 8)) {
      g.strokeStyle = rgba(C.slice, sl.off ? 0.15 : 0.32); g.lineWidth = 1; g.setLineDash([2, 3]);
      g.beginPath(); const xe = Math.round(x1) + 0.5; g.moveTo(xe, yb); g.lineTo(xe, ly); g.stroke(); g.setLineDash([]);
    }
    if (sw >= 17) { g.fillStyle = rgba(C.ink, sl.off ? 0.35 : 0.8); g.fillText(String(sl.i + 1), x0 + 4, wy + 10); }
  }
  g.lineWidth = 1;
}

/** Transient markers: a line with a flag, filled for manual ones. The Groove step shows drum lanes instead. */
export function markers({ g, app, L, C, xOf, beatsMode }: Frame): void {
  if (app.step === 5) return;
  const { w, wy, ly, ey } = L, v = app.view, M = app.markers, i0 = lowerBound(M, v.t0), dense = lowerBound(M, v.t1) - i0 > w / 4, ma = beatsMode ? 0.5 : 1;
  const sel = app.sel?.kind === 'marker' ? app.sel.id : null, hov = app.hover?.kind === 'marker' ? app.hover.id : null;
  for (let i = i0; i < M.length && M[i].t <= v.t1; i++) {
    const m = M[i], x = Math.round(xOf(m.t)) + 0.5, isSel = m.id === sel, isHov = m.id === hov;
    g.strokeStyle = rgba(C.mark, (isSel || isHov ? 1 : dense ? 0.45 : 0.8) * ma); g.lineWidth = isSel ? 2 : 1;
    g.beginPath(); g.moveTo(x, wy + 1); g.lineTo(x, ey); g.stroke();
    if (!beatsMode || isSel) { g.globalAlpha = isSel ? 1 : 0.4; g.beginPath(); g.moveTo(x, ey); g.lineTo(x, ly); g.stroke(); g.globalAlpha = 1; }
    if (!dense || isSel) {
      g.beginPath(); g.moveTo(x - 5, wy + 1); g.lineTo(x + 5, wy + 1); g.lineTo(x, wy + 9); g.closePath();
      g.fillStyle = rgba(C.mark, ma);
      if (m.manual || isSel) g.fill();
      else { g.fillStyle = C.stage; g.fill(); g.lineWidth = 1.2; g.stroke(); }
    }
  }
  g.lineWidth = 1;
}

// The Groove step: kick, snare and hats in three lanes over the waveform (hats on top), each hit a
// tick as tall as it is loud, with a tail back to the grid line it was measured from when zoomed in
// far enough to see a few milliseconds.
const LANES = ['hat', 'snare', 'kick'] as const;
export function drums({ g, app, L, C, xOf }: Frame): void {
  if (app.step !== 5) return;
  const hits = app.drumHits;
  if (!hits) return;
  const { w, wy, wh } = L, v = app.view, lh = wh / 3, pxMs = w / (v.span * 1000), placed = app.pocket?.hits;
  g.font = '600 12px ' + FONT; g.textBaseline = 'middle';
  LANES.forEach((voice, i) => {
    const top = wy + i * lh, mid = top + lh / 2, col = C[voice];
    g.fillStyle = rgba(col, 0.06); g.fillRect(0, top + 1, w, lh - 2);
    g.fillStyle = rgba(col, 0.9); g.fillText(voice === 'hat' ? 'HATS' : voice.toUpperCase(), 6, top + 10);
    const list = placed ? placed.filter((h) => h.voice === voice) : hits[voice].map((h) => ({ t: h.t, vel: 100, gridMs: 0 }));
    for (const h of list) {
      if (h.t < v.t0 - 0.05 || h.t > v.t1 + 0.05) continue;
      const x = Math.round(xOf(h.t)) + 0.5, hh = (lh - 8) * (0.3 + 0.7 * Math.min(1, h.vel / 127));
      if (pxMs >= 0.4 && Math.abs(h.gridMs) * pxMs >= 2) {
        g.strokeStyle = rgba(col, 0.75); g.lineWidth = 2;
        g.beginPath(); g.moveTo(xOf(h.t - h.gridMs / 1000), mid); g.lineTo(x, mid); g.stroke();
      }
      g.strokeStyle = col; g.lineWidth = 2;
      g.beginPath(); g.moveTo(x, mid - hh / 2); g.lineTo(x, mid + hh / 2); g.stroke();
    }
  });
  g.lineWidth = 1;
}

/** Pins: a diamond in the bar ruler, bar 1 in its own colour; plus the grid line under the pointer. */
export function pins({ g, app, L, C, xOf }: Frame): void {
  const { w, ly, ty } = L, map = app.tempoMap;
  const sel = app.sel?.kind === 'anchor' ? app.sel.q : null, hov = app.hover?.kind === 'anchor' ? app.hover.q : null;
  for (const a of map.anchors) {
    const x = Math.round(xOf(a.t)) + 0.5;
    if (x < -8 || x > w + 8) continue;
    const isSel = a.q === sel, isHov = a.q === hov, col = a.q === 0 ? C.down : C.beat, al = app.step === 2 ? 1 : 0.4;
    g.strokeStyle = rgba(col, al); g.lineWidth = isSel || isHov ? 2 : 1.4;
    g.beginPath(); g.moveTo(x, RUL - 2); g.lineTo(x, ty); g.stroke();
    g.beginPath(); g.moveTo(x, RUL - 13); g.lineTo(x + 5, RUL - 8); g.lineTo(x, RUL - 3); g.lineTo(x - 5, RUL - 8); g.closePath();
    if (a.manual) { g.fillStyle = rgba(col, al); g.fill(); } else { g.fillStyle = C.panel; g.fill(); g.lineWidth = 1.3; g.stroke(); }
    if (isSel) { g.lineWidth = 1; g.strokeStyle = C.ink; g.strokeRect(x - 7.5, RUL - 15.5, 15, 15); }
  }
  g.lineWidth = 1;
  if (app.hover?.kind === 'grid') {
    const x = Math.round(xOf(map.posToTime(app.hover.q))) + 0.5;
    g.strokeStyle = C.beat; g.lineWidth = 2; g.beginPath(); g.moveTo(x, RUL - 2); g.lineTo(x, ly); g.stroke(); g.lineWidth = 1;
  }
}

/** The tempo lane: each bar's BPM as a step line. */
export function tempoLane({ g, app, L, C, xOf }: Frame): void {
  const bars = app.bars;
  if (!bars.length) return;
  const { ly, laneH } = L, v = app.view;
  let lo = Infinity, hi = -Infinity;
  for (const b of bars) { if (b.bpm < lo) lo = b.bpm; if (b.bpm > hi) hi = b.bpm; }
  const padv = Math.max(1.5, (hi - lo) * 0.15);
  lo -= padv; hi += padv;
  const yOf = (b: number) => ly + laneH - 6 - ((b - lo) / (hi - lo)) * (laneH - 24);
  g.font = '500 12px ' + FONT; g.textBaseline = 'alphabetic';
  g.beginPath();
  let started = false, lastLab = -99;
  for (const b of bars) {
    if (b.te < v.t0 || b.ts > v.t1) continue;
    const x0 = xOf(b.ts), x1 = xOf(b.te), y = yOf(b.bpm);
    if (!started) { g.moveTo(x0, y); started = true; } else g.lineTo(x0, y);
    g.lineTo(x1, y);
  }
  g.strokeStyle = C.beat; g.lineWidth = 1.6; g.stroke(); g.lineWidth = 1;
  for (const b of bars) {
    if (b.te < v.t0 || b.ts > v.t1) continue;
    const x0 = xOf(b.ts), x1 = xOf(b.te), y = yOf(b.bpm);
    g.fillStyle = rgba(C.beat, 0.13); g.fillRect(x0, y, x1 - x0, ly + laneH - y);
    if (x0 - lastLab > 46) { g.fillStyle = C.ink; g.fillText(b.bpm.toFixed(x1 - x0 > 62 ? 2 : 1), Math.max(3, x0 + 4), y - 4); lastLab = Math.max(3, x0); }
  }
}

const RULER_STEPS = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
export function timeRuler({ g, app, L, C, xOf }: Frame): void {
  const { w, ty } = L, v = app.view, span = v.span, st = RULER_STEPS.find((s) => (s / span) * w >= 70) || 600;
  g.font = '12px ' + FONT; g.textBaseline = 'middle'; g.fillStyle = C.dim; g.strokeStyle = C.line;
  for (let t = Math.ceil(v.t0 / st) * st; t <= v.t1; t += st) {
    const x = Math.round(xOf(t)) + 0.5;
    g.beginPath(); g.moveTo(x, ty); g.lineTo(x, ty + 5); g.stroke();
    const m = Math.floor(t / 60), s = t - m * 60;
    const label = st < 1 ? s.toFixed(st < 0.01 ? 3 : st < 0.1 ? 2 : 1).padStart(st < 0.01 ? 6 : st < 0.1 ? 5 : 4, '0') : String(Math.round(s)).padStart(2, '0');
    g.fillText(m + ':' + label, x + 4, ty + TIME / 2 + 1);
  }
}

export function loopStrip({ g, app, L, C, xOf }: Frame): void {
  const lp = app.transport.loop;
  if (!lp) return;
  const { w, wy, wh, ly } = L, on = app.transport.loopOn, xa = xOf(lp.a), xb = xOf(lp.b), col = on ? C.start : C.dim;
  if (xb <= -4 || xa >= w + 4) return;
  if (on) { g.fillStyle = rgba(C.start, 0.09); g.fillRect(xa, wy + 1, xb - xa, wh - 1); }
  g.fillStyle = rgba(col, 0.35); g.fillRect(xa, LOOPH, 1, ly - LOOPH); g.fillRect(xb - 1, LOOPH, 1, ly - LOOPH);
  g.fillStyle = rgba(col, on ? 0.9 : 0.5); g.beginPath();
  if (g.roundRect) g.roundRect(xa, 3, Math.max(2, xb - xa), LOOPH - 6, 3); else g.rect(xa, 3, Math.max(2, xb - xa), LOOPH - 6);
  g.fill();
  g.fillStyle = C.stage;
  if (xb - xa > 16) { g.fillRect(xa + 3, 6, 1.5, LOOPH - 12); g.fillRect(xb - 4.5, 6, 1.5, LOOPH - 12); }
}

/** The start point: a dashed line and a blue flag in the time ruler. */
export function startFlag({ g, app, L, C, xOf }: Frame): void {
  const { w, wy, ty } = L, x = Math.round(xOf(app.transport.start)) + 0.5;
  if (x < -10 || x > w + 10) return;
  g.strokeStyle = rgba(C.start, 0.9); g.setLineDash([3, 3]); g.beginPath(); g.moveTo(x, wy); g.lineTo(x, ty); g.stroke(); g.setLineDash([]);
  g.fillStyle = C.start; g.fillRect(x - 1, ty, 2, TIME);
  g.beginPath(); g.moveTo(x, ty + 2); g.lineTo(x + 10, ty + 7); g.lineTo(x, ty + 12); g.closePath(); g.fill();
}

/** The dashed line between the edit half and the move half, with a pencil above and arrows below. */
export function editHint({ g, L, C, editable }: Frame): void {
  if (!editable) return;
  const { w, ey } = L;
  g.strokeStyle = rgba(C.ink, 0.35); g.setLineDash([2, 4]); g.beginPath(); g.moveTo(0, ey + 0.5); g.lineTo(w, ey + 0.5); g.stroke(); g.setLineDash([]);
  g.strokeStyle = rgba(C.ink, 0.75); g.lineWidth = 1.5; g.lineCap = 'round'; g.beginPath();
  g.moveTo(7, ey - 7); g.lineTo(15, ey - 15); g.moveTo(7, ey - 7); g.lineTo(7, ey - 10.5); g.moveTo(7, ey - 7); g.lineTo(10.5, ey - 7);
  g.moveTo(5, ey + 11); g.lineTo(17, ey + 11); g.moveTo(8, ey + 8); g.lineTo(5, ey + 11); g.lineTo(8, ey + 14); g.moveTo(14, ey + 8); g.lineTo(17, ey + 11); g.lineTo(14, ey + 14);
  g.stroke(); g.lineWidth = 1; g.lineCap = 'butt';
}

export function playhead({ g, app, L, C, xOf }: Frame): void {
  const { w, h } = L, x = Math.round(xOf(app.transport.playhead)) + 0.5;
  if (x < 0 || x > w) return;
  g.strokeStyle = C.play; g.lineWidth = 1; g.beginPath(); g.moveTo(x, LOOPH); g.lineTo(x, h); g.stroke();
  g.fillStyle = C.play; g.beginPath(); g.moveTo(x - 5, LOOPH); g.lineTo(x + 5, LOOPH); g.lineTo(x, LOOPH + 7); g.closePath(); g.fill();
}
