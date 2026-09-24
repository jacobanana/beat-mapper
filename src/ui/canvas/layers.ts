// The editor canvas, one function per layer, drawn back to front. Each reads the app state and
// draws; none of them changes anything.
import type { App } from '../../app/app';
import { fmtBpm } from '../../core/format';
import { lowerBound } from '../../core/search';
import { GROOVE_GRID_Q } from '../../core/groove/pocket';
import { barQ } from '../../core/tempo/meter';
import { odfOf, odfRef } from '../../core/dsp/onset';
import { LANES, type Layout, LOOPH, RUL, RULH, TIME } from './layout';
import { type Colors, FONT, rgba } from './theme';
import { STEP } from '../../state/steps';

export interface Frame {
  g: CanvasRenderingContext2D;
  app: App;
  L: Layout;
  C: Colors;
  /** Where the audio at source time t is drawn: transients, the playhead, the loop (`app.timeline`). */
  xOf: (t: number) => number;
  /** Where musical position q is drawn: grid lines, bars, pins. */
  xAtPos: (q: number) => number;
  /** The audio in view, from source time t0 to t1. */
  t0: number;
  t1: number;
  /** Beats and later: markers recede. */
  beatsMode: boolean;
  /** Steps 1 to 3 have an edit half. */
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

/**
 * Bar, beat and subdivision lines with their numbers, and the lead-in before bar 1. In the Warp step
 * the grid stays put and the audio is drawn moved onto it, so a transient lined up sits on its line.
 * Returns the finest level shown.
 */
export function grid({ g, app, L, C, xAtPos }: Frame): 0 | 1 | 2 {
  const { w, wy, wh, ly, ty } = L, v = app.view, tl = app.timeline, grid = app.grid;
  const q0 = tl.posAtAxis(v.t0), q1 = tl.posAtAxis(v.t1), pxQ = w / (q1 - q0), bq = grid.barQ, gq = grid.stepQ, btq = grid.beatQ;
  const gridHasBeats = gq <= btq + 1e-9;
  const showSub = gq * pxQ >= 7, showBeat = (gridHasBeats ? btq : gq) * pxQ >= 7, visLevel = showSub ? 2 : showBeat ? 1 : 0;
  let stride = 1;
  while (bq * stride * pxQ < 5) stride *= 2;
  let labStride = stride;
  while (bq * labStride * pxQ < 34) labStride *= 2;
  const a = app.step === STEP.beats || app.step === STEP.warp ? 1 : 0.45;
  g.font = '500 12px ' + FONT;
  g.textBaseline = 'middle';
  for (let b = Math.floor(q0 / bq) - 1; b <= Math.floor(q1 / bq) + 1; b++) {
    if (((b % stride) + stride) % stride) continue;
    for (let j = 0; j * gq < bq - 1e-9; j++) {
      const lv = grid.level(j);
      if (lv > visLevel) continue;
      if (!gridHasBeats && j > 0 && !showBeat) continue;
      const q = b * bq + grid.at(j), x = Math.round(xAtPos(q)) + 0.5;
      if (x < -2 || x > w + 2) continue;
      // In Warp the subdivisions are what transients are dropped on, so they show more.
      g.strokeStyle = rgba(C.beat, (lv === 0 ? 0.75 : lv === 1 ? 0.4 : app.step === STEP.warp ? 0.32 : 0.18) * a * (q < 0 ? 0.5 : 1));
      g.beginPath(); g.moveTo(x, lv === 0 ? LOOPH + 3 : wy); g.lineTo(x, lv === 0 ? ty : ly); g.stroke();
      if (lv === 0 && b >= 0 && !(b % labStride)) { g.fillStyle = rgba(C.ink, a === 1 ? 0.95 : 0.55); g.fillText(String(b + 1), x + 9, LOOPH + RULH / 2 + 1); }
      else if (lv === 1 && btq * pxQ >= 44 && q >= 0) { g.fillStyle = rgba(C.dim, 0.9); g.fillText(b + 1 + '.' + (Math.round((j * gq) / btq) + 1), x + 9, LOOPH + RULH / 2 + 1); }
    }
  }
  // lead-in shade
  const xd = xAtPos(0);
  if (xd > 0) {
    g.fillStyle = rgba(C.stage, 0.55); g.fillRect(0, wy + 1, Math.min(w, xd), wh - 1);
    if (xd > 60 && app.step === STEP.beats) { g.fillStyle = C.dim; g.font = '13px ' + FONT; g.fillText('lead-in', 6, wy + 12); }
  }
  return visLevel;
}

// Transientness: the detection function the markers come from, rising from the bottom of the wave
// area. Full height is its 99th percentile. Zoomed out, each pixel shows the loudest frame it covers.
export function odf({ g, app, L, C, xOf, t0, t1, beatsMode }: Frame): void {
  const an = app.analysis, a = app.audio;
  if (!app.detection.showOdf || !an || !a || app.step === STEP.groove) return;
  const { w, wh, ly } = L, v = app.view, { algo, band } = app.detection;
  const f = odfOf(an, algo, band), ref = odfRef(an, algo, band), dt = an.hop / a.sr, tf = (0.6 * an.N - an.pad) / a.sr, span = v.span, hh = wh - 4;
  const pts: number[] = [];
  if ((t1 - t0) / dt > w) {
    for (let px = 0; px < w; px++) {
      const tl = app.timeline, i0 = Math.max(0, Math.ceil((tl.sourceAt(v.t0 + (span * px) / w) - tf) / dt)), i1 = Math.min(f.length, Math.ceil((tl.sourceAt(v.t0 + (span * (px + 1)) / w) - tf) / dt));
      let m = 0;
      for (let n = i0; n < i1; n++) if (f[n] > m) m = f[n];
      pts.push(px, ly - Math.min(1, m / ref) * hh);
    }
  } else {
    const n0 = Math.max(0, Math.floor((t0 - tf) / dt) - 1), n1 = Math.min(f.length - 1, Math.ceil((t1 - tf) / dt) + 1);
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
  if (app.step !== STEP.slice || !S.length) return;
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

/**
 * Transient markers: a line with a flag, filled for manual ones. The Groove step shows drum lanes
 * instead. In Warp they are what is dragged onto the grid, so they stay bright.
 */
export function markers({ g, app, L, C, xOf, t0, t1, beatsMode }: Frame): void {
  if (app.step === STEP.groove) return;
  const { w, wy, ly, ey } = L, M = app.markers, i0 = lowerBound(M, t0), dense = lowerBound(M, t1) - i0 > w / 4;
  const warping = app.step === STEP.warp, ma = beatsMode && !warping ? 0.5 : 1;
  const sel = app.sel?.kind === 'marker' ? app.sel.id : null, hov = app.hover?.kind === 'marker' ? app.hover.id : null;
  const wSel = app.sel?.kind === 'warp' ? app.sel.t : null, wHov = app.hover?.kind === 'warp' ? app.hover.t : null;
  for (let i = i0; i < M.length && M[i].t <= t1; i++) {
    const m = M[i], x = Math.round(xOf(m.t)) + 0.5, isSel = m.id === sel || m.t === wSel, isHov = m.id === hov || m.t === wHov;
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
// far enough to see a few milliseconds. The transients show faintly behind, since hits placed by hand
// land on them; those hits wear a dot, and the selected or hovered hit a frame.
export function drums({ g, app, L, C, xOf, xAtPos, t0, t1 }: Frame): void {
  if (app.step !== STEP.groove) return;
  const hits = app.drumHits;
  if (!hits) return;
  const { w, wy, wh, ly } = L, v = app.view, lh = wh / 3, pxMs = w / (v.span * 1000), pocket = app.pocket, placed = pocket?.hits, M = app.markers;
  // A hit's tail runs back to its grid step, drawn where the grid is: under the warp, the hit is where
  // the warp puts it, so its tail is what is left of its offset once quantized.
  const bq = barQ(app.doc.meter), sq = pocket ? GROOVE_GRID_Q[pocket.grid] : 0;
  const i0 = lowerBound(M, t0);
  if (lowerBound(M, t1) - i0 <= w / 6) {
    g.strokeStyle = rgba(C.mark, 0.35); g.lineWidth = 1; g.setLineDash([2, 3]); g.beginPath();
    for (let i = i0; i < M.length && M[i].t <= t1; i++) { const x = Math.round(xOf(M[i].t)) + 0.5; g.moveTo(x, wy + 1); g.lineTo(x, ly); }
    g.stroke(); g.setLineDash([]);
  }
  const mark = (s: typeof app.hover) => (s?.kind === 'hit' ? s : null), sel = mark(app.sel), hov = mark(app.hover);
  g.font = '600 12px ' + FONT; g.textBaseline = 'middle';
  LANES.forEach((voice, i) => {
    const top = wy + i * lh, mid = top + lh / 2, col = C[voice];
    g.fillStyle = rgba(col, 0.06); g.fillRect(0, top + 1, w, lh - 2);
    g.fillStyle = rgba(col, 0.9); g.fillText(voice === 'hat' ? 'HATS' : voice.toUpperCase(), 6, top + 10);
    const list = placed ? placed.filter((h) => h.voice === voice) : hits[voice].map((h) => ({ t: h.t, vel: 100, gridMs: 0, bar: 0, step: 0 }));
    const manual = new Set(hits[voice].filter((h) => h.id != null).map((h) => h.t));
    for (const h of list) {
      if (h.t < t0 - 0.05 || h.t > t1 + 0.05) continue;
      const x = Math.round(xOf(h.t)) + 0.5, hh = (lh - 8) * (0.3 + 0.7 * Math.min(1, h.vel / 127));
      if (pxMs >= 0.4 && Math.abs(h.gridMs) * pxMs >= 2) {
        g.strokeStyle = rgba(col, 0.75); g.lineWidth = 2;
        g.beginPath(); g.moveTo(xAtPos(h.bar * bq + h.step * sq), mid); g.lineTo(x, mid); g.stroke();
      }
      g.strokeStyle = col; g.lineWidth = 2;
      g.beginPath(); g.moveTo(x, mid - hh / 2); g.lineTo(x, mid + hh / 2); g.stroke();
      if (manual.has(h.t)) { g.fillStyle = col; g.beginPath(); g.arc(x, mid - hh / 2 - 4, 3, 0, Math.PI * 2); g.fill(); }
      const isSel = sel?.voice === voice && sel.t === h.t;
      if (isSel || (hov?.voice === voice && hov.t === h.t)) {
        g.strokeStyle = isSel ? C.ink : rgba(C.ink, 0.5); g.lineWidth = 1;
        g.strokeRect(x - 5.5, mid - hh / 2 - 8.5, 11, hh + 12);
      }
    }
  });
  g.lineWidth = 1;
}

/** Pins: a diamond in the bar ruler, bar 1 in its own colour; plus the grid line under the pointer. */
export function pins({ g, app, L, C, xAtPos }: Frame): void {
  const { w, ly, ty } = L, map = app.tempoMap;
  const sel = app.sel?.kind === 'anchor' ? app.sel.q : null, hov = app.hover?.kind === 'anchor' ? app.hover.q : null;
  for (const a of map.anchors) {
    const x = Math.round(xAtPos(a.q)) + 0.5;
    if (x < -8 || x > w + 8) continue;
    const isSel = a.q === sel, isHov = a.q === hov, col = a.q === 0 ? C.down : C.beat, al = app.step === STEP.beats ? 1 : 0.4;
    g.strokeStyle = rgba(col, al); g.lineWidth = isSel || isHov ? 2 : 1.4;
    g.beginPath(); g.moveTo(x, RUL - 2); g.lineTo(x, ty); g.stroke();
    g.beginPath(); g.moveTo(x, RUL - 13); g.lineTo(x + 5, RUL - 8); g.lineTo(x, RUL - 3); g.lineTo(x - 5, RUL - 8); g.closePath();
    if (a.manual) { g.fillStyle = rgba(col, al); g.fill(); } else { g.fillStyle = C.panel; g.fill(); g.lineWidth = 1.3; g.stroke(); }
    if (isSel) { g.lineWidth = 1; g.strokeStyle = C.ink; g.strokeRect(x - 7.5, RUL - 15.5, 15, 15); }
  }
  g.lineWidth = 1;
  if (app.hover?.kind === 'grid') {
    const x = Math.round(xAtPos(app.hover.q)) + 0.5;
    g.strokeStyle = C.beat; g.lineWidth = 2; g.beginPath(); g.moveTo(x, RUL - 2); g.lineTo(x, ly); g.stroke(); g.lineWidth = 1;
  }
}

/**
 * Warp markers, in the Warp step: a transient held on its grid line, drawn as a thicker line with a
 * tab in the bar ruler. While a transient is dragged, a ghost at the grid line it would land on, and
 * an arrow from where it is.
 */
export function warpMarkers({ g, app, L, C, xOf, xAtPos, t0, t1 }: Frame): void {
  if (app.step !== STEP.warp) return;
  const { w, wy, ly } = L, sel = app.sel?.kind === 'warp' ? app.sel.t : null, drag = app.warpDrag;
  const tab = (x: number, fill: boolean) => {
    g.beginPath(); g.moveTo(x - 6, RUL - 14); g.lineTo(x + 6, RUL - 14); g.lineTo(x + 6, RUL - 7); g.lineTo(x, RUL - 2); g.lineTo(x - 6, RUL - 7); g.closePath();
    if (fill) g.fill(); else { g.fillStyle = C.panel; g.fill(); g.stroke(); }
  };
  for (const m of app.doc.warpMarkers) {
    if (m.t < t0 - 0.05 || m.t > t1 + 0.05 || m.t === drag?.t) continue;
    const x = Math.round(xOf(m.t)) + 0.5, isSel = m.t === sel;
    g.strokeStyle = C.mark; g.fillStyle = C.mark; g.lineWidth = isSel ? 3 : 2;
    g.beginPath(); g.moveTo(x, RUL - 2); g.lineTo(x, ly); g.stroke();
    g.lineWidth = 1; tab(x, true);
    if (isSel) { g.strokeStyle = C.ink; g.strokeRect(x - 8.5, RUL - 16.5, 17, 16); }
  }
  if (!drag) return;
  const xs = xOf(drag.t), on = drag.q != null, xt = on ? xAtPos(drag.q!) : xOf(drag.at), y = wy + (ly - wy) * 0.25;
  if (xt < -20 || xt > w + 20) { g.lineWidth = 1; return; }
  g.strokeStyle = rgba(C.mark, on ? 1 : 0.45); g.fillStyle = g.strokeStyle; g.lineWidth = 2;
  g.setLineDash([4, 3]); g.beginPath(); g.moveTo(xs, y); g.lineTo(xt, y); g.stroke(); g.setLineDash([]);
  const dir = xt >= xs ? 1 : -1;
  if (Math.abs(xt - xs) > 10) { g.beginPath(); g.moveTo(xt, y); g.lineTo(xt - dir * 8, y - 5); g.lineTo(xt - dir * 8, y + 5); g.closePath(); g.fill(); }
  const x = Math.round(xt) + 0.5;
  g.beginPath(); g.moveTo(x, RUL - 2); g.lineTo(x, ly); g.stroke();
  g.lineWidth = 1; if (on) tab(x, true); else { g.strokeStyle = rgba(C.mark, 0.45); tab(x, false); }
}

/**
 * The tempo lane: each bar's BPM as a step line. In the Warp step and wherever the warp is heard, the
 * grid's tempo too, as a dashed line, and the gap each bar is moved across to reach it. The bars are the tempo map's, drawn on its
 * grid: warp markers move hits within their bars, not the bars' tempo.
 */
export function tempoLane({ g, app, L, C, xOf, xAtPos }: Frame): void {
  const bars = app.bars, bq = barQ(app.doc.meter);
  if (!bars.length) return;
  // The bars' times are the tempo map's, which is the axis: they are culled against the view as it is.
  // The grid's tempo wherever the warp is heard, and in the Warp step whatever is heard, since it is
  // what that step sets.
  const { w, ly, laneH } = L, v = app.view, t0 = v.t0, t1 = v.t1, warp = app.heard?.plan ?? (app.step === STEP.warp ? app.warpPlan : null);
  let lo = Infinity, hi = -Infinity;
  for (const b of bars) { if (b.bpm < lo) lo = b.bpm; if (b.bpm > hi) hi = b.bpm; }
  if (warp) { lo = Math.min(lo, warp.bpm); hi = Math.max(hi, warp.bpm); }
  const padv = Math.max(1.5, (hi - lo) * 0.15);
  lo -= padv; hi += padv;
  const yOf = (b: number) => ly + laneH - 6 - ((b - lo) / (hi - lo)) * (laneH - 24);
  g.font = '500 12px ' + FONT; g.textBaseline = 'alphabetic';
  g.beginPath();
  let started = false, lastLab = -99;
  for (const b of bars) {
    if (b.te < t0 || b.ts > t1) continue;
    const x0 = xAtPos(b.b * bq), x1 = xAtPos((b.b + 1) * bq), y = yOf(b.bpm);
    if (!started) { g.moveTo(x0, y); started = true; } else g.lineTo(x0, y);
    g.lineTo(x1, y);
  }
  g.strokeStyle = C.beat; g.lineWidth = 1.6; g.stroke(); g.lineWidth = 1;
  const yw = warp ? yOf(warp.bpm) : 0;
  for (const b of bars) {
    if (b.te < t0 || b.ts > t1) continue;
    const x0 = xAtPos(b.b * bq), x1 = xAtPos((b.b + 1) * bq), y = yOf(b.bpm);
    if (warp) {
      // What the warp does to the bar: the gap between its tempo and the grid's.
      g.fillStyle = rgba(b.bpm > warp.bpm ? C.start : C.down, 0.22); g.fillRect(x0, Math.min(y, yw), x1 - x0, Math.abs(y - yw));
    } else { g.fillStyle = rgba(C.beat, 0.13); g.fillRect(x0, y, x1 - x0, ly + laneH - y); }
    if (x0 - lastLab > 46) { g.fillStyle = C.ink; g.fillText(b.bpm.toFixed(x1 - x0 > 62 ? 2 : 1), Math.max(3, x0 + 4), y - 4); lastLab = Math.max(3, x0); }
  }
  if (warp) {
    const xa = Math.max(0, xOf(warp.range.a)), xb = Math.min(w, xOf(warp.range.b));
    g.strokeStyle = C.ink; g.setLineDash([4, 3]); g.beginPath(); g.moveTo(xa, yw + 0.5); g.lineTo(xb, yw + 0.5); g.stroke(); g.setLineDash([]);
    // On a backing, since it sits among the bars' own tempo labels.
    const lab = 'grid ' + fmtBpm(warp.bpm), tw = g.measureText(lab).width, xr = Math.max(xa + tw + 8, xb - 4), yt = yw > ly + 16 ? yw - 3 : yw + 13;
    g.fillStyle = C.panel; g.fillRect(xr - tw - 4, yt - 11, tw + 8, 14);
    g.fillStyle = C.ink; g.textAlign = 'right'; g.fillText(lab, xr, yt); g.textAlign = 'left';
  }
}

const RULER_STEPS = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
export function timeRuler({ g, L, C, xOf, t0, t1 }: Frame): void {
  const { w, ty } = L, span = t1 - t0, st = RULER_STEPS.find((s) => (s / span) * w >= 70) || 600;
  g.font = '12px ' + FONT; g.textBaseline = 'middle'; g.fillStyle = C.dim; g.strokeStyle = C.line;
  for (let t = Math.ceil(t0 / st) * st; t <= t1; t += st) {
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
