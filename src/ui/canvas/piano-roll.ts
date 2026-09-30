// The Notes step's chart: the notes found or drawn, as a piano roll under a moving playhead, over the
// spectrogram of the audio when it is shown. The loop when it is on, else what the editor shows, so it
// scrolls with playback; bar and beat lines from the tempo map. Everything is placed by the timeline,
// as in the editor, so heard warped a note is where the warp puts it, and the spectrogram is drawn
// column by column through the same timeline, so its lines sit under the notes wherever they are put.
// Tap a note to hear it, select it and put the playhead on it; double-tap it to delete it; tap anywhere
// else to hear that pitch and put the playhead there, or a note name to hear it. With the pencil on,
// drag on the roll to draw a note, drag a note to move it, or its end to lengthen it, each pitch heard
// as it is reached, its start and end landing on a transient or the grid as the roll's magnet is set; off, a drag scrolls in time and pitch. Two fingers pinch to zoom: spread sideways
// they zoom the time, up and down the rows, across both; moved together, they scroll. The wheel
// scrolls the rows, and zooms in time with Ctrl (a trackpad's pinch), scrolls in time with Shift, and
// zooms the rows with Alt. The rows also scroll by dragging the note names.
import type { App } from '../../app/app';
import type { Features } from '../../app/features';
import { type HeardNote, MIN_NOTE, noteKey } from '../../core/notes/select';
import { SPEC_HI, SPEC_LO } from '../../core/notes/spectrogram';
import type { Note } from '../../core/notes/types';
import { noteName } from '../../core/notes/types';
import { lowerBound, nearest } from '../../core/search';
import { barQ, beatQ } from '../../core/tempo/meter';
import { type Colors, FONT, readColors, rgba } from './theme';

const LABEL_W = 36, TOP = 18, BOTTOM = 20;
/**
 * A row is never thinner than a finger can tell apart, nor taller than looks like a roll: the roll in
 * the main view gets a little more, so it shows the notes bigger rather than octaves nothing plays in.
 */
const MIN_ROW = 6, MAX_ROW = 12, MAX_ROW_BIG = 18;
/** How far the rows can be zoomed, as a row's height: past the fit above, down to a hair, up to a thumb. */
const ZOOM_ROW = { min: 3, max: 48 };
/**
 * How far apart two fingers must start along an axis for the pinch to zoom it: closer, the wobble of
 * a pinch made along the other axis would zoom this one too.
 */
const PINCH_AXIS = 60;
/** How long a pitch tried on an empty row, or a note name, is heard. */
const TRY_PITCH = 0.35;
const BLACK = new Set([1, 3, 6, 8, 10]);

interface Box { x0: number; x1: number; y0: number; y1: number; n: HeardNote }

type Drag =
  | { kind: 'scroll'; y0: number; top0: number; moved: boolean }
  | { kind: 'pan'; x0: number; y0: number; top0: number; v0: { t0: number; t1: number }; box: Box | undefined; moved: boolean }
  | { kind: 'new'; x0: number; y0: number; pitch: number; t: number; moved: boolean }
  | { kind: 'move' | 'resize'; x0: number; y0: number; box: Box; from: Note; moved: boolean; heard: number };

export class PianoRoll {
  private readonly g: CanvasRenderingContext2D;
  private C: Colors = readColors();
  private queued = false;
  /** Where each note was drawn, for the pointer. */
  private boxes: Box[] = [];
  private lastTap = { t: 0, key: '' };
  /**
   * The pitch at the top edge of the rows, fractional so the rows scroll and zoom smoothly: row p is
   * drawn from (top - p) rows down. Null centres the rows on the notes.
   */
  private top: number | null = null;
  /** The transcript the rows were last centred on, so a new one recentres them. */
  private centredOn: unknown = null;
  /** Where the last draw put things, for the pointer. */
  private axis = { t0: 0, span: 1, L: LABEL_W + 4, R: 100, rh: MIN_ROW, top: 60, rows: 12 };
  private drag: Drag | null = null;
  /** Where each finger is, for the pinch. */
  private readonly ptrs = new Map<number, { x: number; y: number }>();
  /** Two fingers down: where they started, and the view and rows then. */
  private pinch: { dx: number; dy: number; zx: boolean; zy: boolean; mx: number; my: number; v0: { t0: number; t1: number }; rh0: number; zoom0: number; pitch: number } | null = null;
  /** The rows zoomed by the user, over the height that fits the notes. */
  private zoomY = 1;
  /** A pitch to keep at a height on the next draw, while the rows are zoomed around it. */
  private anchor: { pitch: number; y: number } | null = null;
  /** A note being drawn, before it is let go. */
  private preview: { pitch: number; t: number; end: number } | null = null;
  /** The spectrogram's pixels, kept between redraws that only moved the playhead. */
  private specImg: { key: string; view: Float32Array; tl: unknown; cv: HTMLCanvasElement } | null = null;
  private ramp: { C: Colors; rgba: Uint8ClampedArray } | null = null;

  constructor(private readonly cv: HTMLCanvasElement, private readonly app: App, private readonly f: Features) {
    this.g = cv.getContext('2d')!;
    app.bus.on(['transcript', 'spectrum', 'notes', 'doc', 'transport', 'step', 'audio', 'beats', 'heard', 'selection', 'playhead', 'view'], () => this.invalidate());
    cv.addEventListener('pointerdown', (e) => this.down(e));
    cv.addEventListener('pointermove', (e) => this.move(e));
    cv.addEventListener('pointerup', (e) => this.up(e));
    cv.addEventListener('pointercancel', (e) => this.cancel(e));
    cv.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
  }

  /** Redraws on the next frame, once however many changes come in before it. */
  invalidate(): void {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => { this.queued = false; this.draw(); });
  }

  recolor(): void { this.C = readColors(); this.ramp = null; this.specImg = null; this.invalidate(); }

  // ---------- the pointer ----------
  private local(e: PointerEvent): { x: number; y: number } {
    const r = this.cv.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private hit(x: number, y: number, touch: boolean): Box | undefined {
    // The nearest note under the pointer, with a few pixels of slack for a finger.
    const pad = touch ? 8 : 3;
    return this.boxes.find((b) => x >= b.x0 - pad && x <= b.x1 + pad && y >= b.y0 - pad && y <= b.y1 + pad);
  }

  /** The time of the audio drawn at x, and x of a time. */
  private tOf(x: number): number { const a = this.axis; return this.app.timeline.sourceAt(a.t0 + ((x - a.L) / (a.R - a.L)) * a.span); }
  private xOf(t: number): number { const a = this.axis; return a.L + ((this.app.timeline.axisAt(t) - a.t0) / a.span) * (a.R - a.L); }
  private pitchAt(y: number): number { const a = this.axis; return Math.max(0, Math.min(127, Math.ceil(a.top - (y - TOP) / a.rh))); }

  /**
   * Where a drawn note's start or end lands, as the roll's magnet is set: with both, on a transient
   * within a finger's reach, else on the grid line nearest. Alt lets it go anywhere.
   */
  private snap(t: number, e: PointerEvent): number {
    const { app } = this, mode = e.altKey ? 'off' : app.notes.snap;
    t = Math.max(0, Math.min(app.dur, t));
    if (mode === 'both' || mode === 'markers') {
      const m = nearest(app.markers, t);
      if (m && Math.abs(this.xOf(m.t) - this.xOf(t)) <= (e.pointerType === 'touch' ? 14 : 9)) return m.t;
    }
    return mode === 'both' || mode === 'grid' ? this.f.playback.gridSnap(t) : t;
  }

  /** How long a tapped note is: one grid step, or a quarter of a second without a map. */
  private stepFrom(t: number): number {
    const { app } = this, tl = app.timeline;
    if (tl.map.isEmpty) return t + 0.25;
    const q = tl.posOf(t);
    return Math.max(t + MIN_NOTE, tl.sourceOfPos(q + app.grid.stepQ));
  }

  private tapNote(b: Box): void {
    const key = noteKey(b.n), now = performance.now();
    if (key === this.lastTap.key && now - this.lastTap.t < 350) { this.f.notes.removeNote(b.n.pitch, b.n.t); this.lastTap = { t: 0, key: '' }; return; }
    this.lastTap = { t: now, key };
    this.f.notes.selectNote(b.n.pitch, b.n.t);
    this.hear(b.n.pitch, b.n.end - b.n.t, b.n.vel);
  }

  /** A pitch heard now on the synth voice. */
  private hear(pitch: number, dur: number, vel = 100): void { this.f.playback.auditionNote(pitch, dur, vel); }

  private down(e: PointerEvent): void {
    const { x, y } = this.local(e), touch = e.pointerType === 'touch', a = this.axis;
    // The first finger (or the mouse) down means no other is: one lifted where the roll didn't hear it
    // must not turn the next drag into a pinch.
    if (e.isPrimary) this.ptrs.clear();
    this.ptrs.set(e.pointerId, { x, y });
    if (this.ptrs.size === 2 && this.app.audio) {
      // A second finger: whatever the first was doing is let go, and the two zoom and scroll.
      this.cancelDrag();
      this.cv.setPointerCapture(e.pointerId);
      const [p, q] = [...this.ptrs.values()], mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2;
      const dx = Math.abs(p.x - q.x), dy = Math.abs(p.y - q.y);
      this.pinch = {
        dx: Math.max(24, dx), dy: Math.max(24, dy), zx: dx >= PINCH_AXIS || dx >= dy, zy: dy >= PINCH_AXIS || dy > dx, mx, my,
        v0: { t0: this.app.view.t0, t1: this.app.view.t1 }, rh0: a.rh, zoom0: this.zoomY, pitch: a.top + 0.5 - (my - TOP) / a.rh,
      };
      return;
    }
    if (this.drag || this.pinch) return;
    if (x < LABEL_W && this.top != null) {
      this.drag = { kind: 'scroll', y0: y, top0: this.top, moved: false };
      this.cv.setPointerCapture(e.pointerId);
      return;
    }
    const box = this.hit(x, y, touch);
    if (!this.app.notes.draw) {
      // A tap selects a note or moves the playhead, told apart from a drag when the finger lifts.
      if (!this.app.audio) return;
      this.cv.setPointerCapture(e.pointerId);
      this.drag = { kind: 'pan', x0: x, y0: y, top0: this.top ?? a.top, v0: { t0: this.app.view.t0, t1: this.app.view.t1 }, box, moved: false };
      return;
    }
    if (!this.app.audio || y < TOP || y > TOP + a.rows * a.rh) return;
    e.preventDefault();
    this.cv.setPointerCapture(e.pointerId);
    if (box) {
      const from = this.app.pickedNotes.find((n) => noteKey(n) === noteKey(box.n));
      if (!from) return;
      // The last few pixels of a note are its end, to lengthen it; the rest moves it.
      const grip = Math.min(touch ? 14 : 7, (box.x1 - box.x0) / 2);
      this.drag = { kind: x >= box.x1 - grip ? 'resize' : 'move', x0: x, y0: y, box, from, moved: false, heard: from.pitch };
    } else {
      const pitch = this.pitchAt(y);
      this.drag = { kind: 'new', x0: x, y0: y, pitch, t: this.snap(this.tOf(x), e), moved: false };
      this.hear(pitch, TRY_PITCH);
    }
  }

  private move(e: PointerEvent): void {
    const { x, y } = this.local(e), touch = e.pointerType === 'touch', a = this.axis;
    if (this.ptrs.has(e.pointerId)) this.ptrs.set(e.pointerId, { x, y });
    if (this.pinch) { if (this.ptrs.size === 2) this.pinchTo(); return; }
    const d = this.drag;
    if (!d) return;
    if (d.kind === 'pan') {
      if (!d.moved && Math.hypot(x - d.x0, y - d.y0) < (touch ? 8 : 4)) return;
      d.moved = true;
      this.panBy(d.v0, x - d.x0);
      this.top = this.clampTop(d.top0 + (y - d.y0) / a.rh);
      this.invalidate();
      return;
    }
    if (d.kind === 'scroll') {
      if (Math.abs(y - d.y0) >= 4) d.moved = true;
      this.top = this.clampTop(d.top0 + (y - d.y0) / a.rh);
      this.invalidate();
      return;
    }
    if (!d.moved && Math.hypot(x - d.x0, y - d.y0) < 4) return;
    if (!d.moved) { d.moved = true; if (d.kind !== 'new') this.f.notes.beginDrag(); }
    if (d.kind === 'new') {
      const t1 = this.snap(this.tOf(x), e), t = Math.min(d.t, t1);
      this.preview = { pitch: d.pitch, t, end: Math.max(t + MIN_NOTE, Math.max(d.t, t1)) };
      this.invalidate();
    } else if (d.kind === 'resize') {
      this.f.notes.dragTo(d.from, { pitch: d.from.pitch, t: d.from.t, end: Math.max(d.from.t + MIN_NOTE, this.snap(this.tOf(x), e)) });
    } else {
      // Moved by the distance dragged along the axis, so under the warp it stays where the finger is.
      const t = this.snap(this.tOf(this.xOf(d.from.t) + (x - d.x0)), e), dp = Math.round((d.y0 - y) / a.rh);
      this.f.notes.dragTo(d.from, { pitch: d.from.pitch + dp, t, end: t + (d.from.end - d.from.t) });
      // Moved to another row: its new pitch heard, so it is put where it sounds right.
      if (d.from.pitch + dp !== d.heard) { d.heard = d.from.pitch + dp; this.hear(d.heard, TRY_PITCH); }
    }
  }

  private up(e: PointerEvent): void {
    this.ptrs.delete(e.pointerId);
    if (this.pinch) { if (this.ptrs.size < 2) this.pinch = null; return; }
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    if (d.kind === 'scroll') {
      // A note name tapped, like a key: its pitch heard.
      if (!d.moved) this.hear(this.pitchAt(d.y0), TRY_PITCH);
      return;
    }
    if (d.kind === 'pan') {
      if (d.moved) return;
      if (d.box) this.tapNote(d.box);
      else {
        this.app.select(null);
        this.f.playback.seek(Math.max(0, Math.min(this.app.dur, this.tOf(d.x0))));
        if (d.y0 >= TOP && d.y0 < TOP + this.axis.rows * this.axis.rh) this.hear(this.pitchAt(d.y0), TRY_PITCH);
      }
      return;
    }
    if (d.kind === 'new') {
      const p = this.preview;
      this.preview = null;
      if (d.moved && p) this.f.notes.addNote(p.pitch, p.t, p.end);
      // A tap draws one grid step, for a finger that can't drag without scrolling.
      else if (!d.moved) this.f.notes.addNote(d.pitch, d.t, this.stepFrom(d.t));
    } else if (!d.moved) this.tapNote(d.box);
    else this.f.notes.endDrag();
  }

  private cancel(e: PointerEvent): void {
    this.ptrs.delete(e.pointerId);
    if (this.ptrs.size < 2) this.pinch = null;
    this.cancelDrag();
  }

  /** Lets go of a drag: a note being drawn is dropped, one being moved stays where it got to. */
  private cancelDrag(): void {
    const d = this.drag;
    this.drag = null;
    this.preview = null;
    if (d && (d.kind === 'move' || d.kind === 'resize') && d.moved) this.f.notes.endDrag();
    this.invalidate();
  }

  /** Scrolls the view in time by dx pixels from where it was, the audio following the finger. */
  private panBy(v0: { t0: number; t1: number }, dx: number): void {
    const a = this.axis, dt = (dx / Math.max(1, a.R - a.L)) * (v0.t1 - v0.t0);
    this.app.setView(v0.t0 - dt, v0.t1 - dt);
  }

  /** Two fingers: spread apart in time zooms the time, apart in pitch the rows, both at once; moved together, scrolls. */
  private pinchTo(): void {
    const P = this.pinch!, [p, q] = [...this.ptrs.values()], a = this.axis, W = Math.max(1, a.R - a.L);
    const dx = Math.max(24, Math.abs(p.x - q.x)), dy = Math.max(24, Math.abs(p.y - q.y)), mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2;
    // Each axis the fingers started spread along zooms by how much further apart they are on it, so a
    // pinch across both zooms both, and one along the time doesn't zoom the rows by its wobble.
    const span0 = P.v0.t1 - P.v0.t0;
    const span = P.zx ? Math.max(Math.min(0.05, this.app.dur), Math.min(this.app.dur, (span0 * P.dx) / dx)) : span0;
    const tc = P.v0.t0 + ((P.mx - a.L) / W) * span0, t0 = tc - ((mx - a.L) / W) * span;
    this.app.setView(t0, t0 + span);
    const rh = !P.zy ? P.rh0 : Math.max(ZOOM_ROW.min, Math.min(ZOOM_ROW.max, (P.rh0 * dy) / P.dy));
    this.zoomY = (P.zoom0 * rh) / P.rh0;
    this.anchor = { pitch: P.pitch, y: my };
    this.invalidate();
  }

  private wheel(e: WheelEvent): void {
    if (this.top == null || !this.app.audio) return;
    e.preventDefault();
    const { x, y } = { x: e.offsetX, y: e.offsetY }, a = this.axis, unit = e.deltaMode === 0 ? 1 : 16;
    if (e.ctrlKey || e.metaKey) {
      // Zoomed in time around the pointer, as the editor's wheel does.
      const v = this.app.view, tc = v.t0 + ((x - a.L) / Math.max(1, a.R - a.L)) * v.span;
      v.zoomAt(Math.exp(Math.max(-120, Math.min(120, e.deltaY * unit)) * 0.01), tc);
      this.app.bus.emit('view');
    } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      const d = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) * unit, v = this.app.view;
      this.panBy({ t0: v.t0, t1: v.t1 }, -d);
    } else if (e.altKey) {
      this.zoomY = Math.max(0.25, Math.min(8, this.zoomY * Math.exp(-Math.sign(e.deltaY) * 0.15)));
      this.anchor = { pitch: a.top + 0.5 - (y - TOP) / a.rh, y };
      this.invalidate();
    } else {
      this.top = this.clampTop(this.top - Math.sign(e.deltaY) * (e.deltaMode === 0 ? Math.max(1, Math.round(Math.abs(e.deltaY) / 40)) : 2));
      this.invalidate();
    }
  }

  private clampTop(top: number): number { return Math.max(SPEC_LO + this.axis.rows - 1, Math.min(SPEC_HI, top)); }

  // ---------- drawing ----------
  /** The spectrogram's colours, from nothing through the waveform's blue-grey to the markers' orange. */
  private rampFor(C: Colors): Uint8ClampedArray {
    if (this.ramp && this.ramp.C === C) return this.ramp.rgba;
    const hex = (h: string) => { const s = h.replace('#', ''), n = parseInt(s.length === 3 ? s.split('').map((c) => c + c).join('') : s, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
    const lo = hex(C.wave), hi = hex(C.mark), out = new Uint8ClampedArray(256 * 4);
    for (let i = 0; i < 256; i++) {
      // Brighter low down than a plain square: with the filters taking the noise out, what is left
      // near the bottom of the range is quiet notes, which should still read.
      const t = i / 255, m = Math.pow(t, 1.5);
      out[i * 4] = lo[0] + (hi[0] - lo[0]) * m;
      out[i * 4 + 1] = lo[1] + (hi[1] - lo[1]) * m;
      out[i * 4 + 2] = lo[2] + (hi[2] - lo[2]) * m;
      out[i * 4 + 3] = 255 * Math.pow(t, 0.7);
    }
    this.ramp = { C, rgba: out };
    return out;
  }

  /**
   * The spectrogram between the rows shown, one column a pixel: each column is the loudest of the
   * frames drawn under it, read through the timeline so the columns sit where the audio is drawn.
   */
  private drawSpectrogram(W: number, pTop: number, pBottom: number): void {
    const { app, g, C } = this, S = app.spectrum, V = app.pitchView, a = this.axis;
    if (!S || !V || W <= 0) return;
    const b0 = Math.max(0, Math.round((pBottom - S.lo) * S.perSemitone)), b1 = Math.min(S.bins, Math.round((pTop + 1 - S.lo) * S.perSemitone)), Hb = b1 - b0;
    if (Hb <= 0) return;
    const tl = app.timeline, range = app.notes.range, key = [W, a.t0, a.span, b0, b1, range].join(',');
    let img = this.specImg;
    if (!img || img.key !== key || img.view !== V || img.tl !== tl) {
      const cv = img?.cv ?? document.createElement('canvas');
      if (cv.width !== W || cv.height !== Hb) { cv.width = W; cv.height = Hb; }
      const ctx = cv.getContext('2d')!, px = ctx.createImageData(W, Hb), data = px.data, ramp = this.rampFor(C), bins = S.bins, dur = app.dur;
      for (let x = 0; x < W; x++) {
        const s0 = tl.sourceAt(a.t0 + (x / W) * a.span), s1 = tl.sourceAt(a.t0 + ((x + 1) / W) * a.span);
        if (s1 < 0 || s0 > dur) continue;
        const f0 = Math.max(0, Math.min(S.frames - 1, Math.floor(Math.min(s0, s1) * S.fr))), f1 = Math.max(f0, Math.min(S.frames - 1, Math.ceil(Math.max(s0, s1) * S.fr) - 1));
        for (let b = b0; b < b1; b++) {
          let m = -Infinity;
          for (let f = f0; f <= f1; f++) { const v = V[f * bins + b]; if (v > m) m = v; }
          const i = Math.max(0, Math.min(255, Math.round((255 * (m + range)) / range)));
          if (i === 0) continue;
          const o = ((Hb - 1 - (b - b0)) * W + x) * 4;
          data[o] = ramp[i * 4]; data[o + 1] = ramp[i * 4 + 1]; data[o + 2] = ramp[i * 4 + 2]; data[o + 3] = ramp[i * 4 + 3];
        }
      }
      ctx.putImageData(px, 0, 0);
      img = this.specImg = { key, view: V, tl, cv };
    }
    // Bin b's lower edge is at pitch lo - 0.5 + b / perSemitone; row p spans p - 0.5 to p + 0.5.
    const yEdge = (p: number) => TOP + (a.top + 0.5 - p) * a.rh;
    const y0 = yEdge(S.lo - 0.5 + b1 / S.perSemitone), y1 = yEdge(S.lo - 0.5 + b0 / S.perSemitone);
    g.imageSmoothingEnabled = true;
    g.drawImage(img.cv, 0, 0, W, Hb, a.L, y0, W, y1 - y0);
  }

  draw(): void {
    const { cv, g, app, C } = this;
    if (cv.offsetParent === null) return; // hidden: drawn when the step opens
    const dpr = Math.max(1, window.devicePixelRatio || 1), w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    g.font = '12px ' + FONT;
    g.textBaseline = 'middle';
    this.boxes = [];
    const spec = app.notes.spec && !!app.spectrum, byHand = app.transcript?.mode === 'draw';
    // Hidden, the notes are neither drawn nor hit, so the spectrogram is seen, and tapped, alone.
    const shown = app.notes.showNotes, notes = shown ? app.heardNotes : [];
    if (!notes.length && !spec) {
      g.fillStyle = C.dim; g.textAlign = 'center';
      g.fillText(app.transcript ? (byHand ? 'Switch on Draw, then drag on the roll' : 'No notes at this sensitivity') : app.audio ? 'Finding the notes…' : '', w / 2, h / 2);
      g.textAlign = 'left';
      return;
    }
    // The rows: as many as the notes found span, with a little room, at least an octave, each at
    // least a finger's width. More notes than fit scroll; a new take's rows are centred on its notes.
    const found = app.transcript?.notes ?? [];
    let lo = 127, hi = 0;
    for (const n of found.length ? found : app.heardNotes) { lo = Math.min(lo, n.pitch); hi = Math.max(hi, n.pitch); }
    if (lo > hi) { lo = 40; hi = 64; }
    const big = app.notes.main === 'roll', area = h - TOP - BOTTOM;
    const fit = Math.max(MIN_ROW, Math.min(big ? MAX_ROW_BIG : MAX_ROW, area / Math.max(12, hi - lo + 3)));
    const rh = Math.max(ZOOM_ROW.min, Math.min(ZOOM_ROW.max, fit * this.zoomY)), rows = Math.max(1, area / rh);
    this.zoomY = rh / fit;
    // Grown or shrunk (moved to the main view and back, or the window resized), the rows keep the
    // pitch in their middle.
    const was = this.axis.rows;
    this.axis.rows = rows;
    if (this.top != null && rows !== was) this.top = this.clampTop(this.top - was / 2 + rows / 2);
    this.axis.rh = rh;
    if (this.top == null || this.centredOn !== app.transcript) {
      this.centredOn = app.transcript;
      this.top = this.clampTop(Math.round((lo + hi) / 2 + rows / 2));
    }
    // Zoomed around a pitch: that pitch stays under the fingers or the pointer.
    if (this.anchor) { this.top = this.clampTop(this.anchor.pitch - 0.5 + (this.anchor.y - TOP) / rh); this.anchor = null; }
    // The rows at least partly in view, the top and bottom ones cut by the clip.
    const top = this.top, pTop = Math.ceil(top - 1e-6), bottom = Math.floor(top - rows + 1 + 1e-6), yOf = (p: number) => TOP + (top - p) * rh;
    const clipRows = (x0: number, x1: number) => { g.save(); g.beginPath(); g.rect(x0, TOP, x1 - x0, area); g.clip(); };

    // In the main view the roll is the editor, and zooms and scrolls as it does; beside the controls
    // it shows the loop when it is on, so the loop can be watched while the editor is elsewhere.
    const tl = app.timeline, loop = big ? null : app.activeLoop;
    const range = loop ? { a: tl.axisAt(loop.a), b: tl.axisAt(loop.b) } : { a: app.view.t0, b: app.view.t1 };
    const L = LABEL_W + 4, R = w - 8, t0 = range.a, span = Math.max(1e-3, range.b - range.a);
    Object.assign(this.axis, { t0, span, L, R, top });
    const xOf = (t: number) => L + ((t - t0) / span) * (R - L), axisY = h - BOTTOM + 4;
    g.save();
    g.beginPath(); g.rect(L, 0, R - L, h); g.clip();
    // The black keys' rows shaded, a line under every C.
    clipRows(L, R);
    for (let p = bottom; p <= pTop; p++) {
      if (BLACK.has(p % 12)) { g.fillStyle = rgba(C.ink, 0.045); g.fillRect(L, yOf(p), R - L, rh); }
      if (p % 12 === 0) { g.fillStyle = rgba(C.ink, 0.14); g.fillRect(L, Math.round(yOf(p) + rh) - 0.5, R - L, 1); }
    }
    if (spec) this.drawSpectrogram(Math.ceil(R - L), pTop, bottom);
    g.restore();
    // Grid: beats faint, bars stronger with their numbers.
    const meter = app.doc.meter;
    if (app.hasMap && !tl.map.isEmpty) {
      const bq = barQ(meter), btq = beatQ(meter), q0 = tl.posAtAxis(t0), q1 = tl.posAtAxis(t0 + span);
      const pxQ = (R - L) / Math.max(1e-6, q1 - q0), unit = pxQ * btq >= 8 ? btq : bq;
      // Zoomed out, a bar number every so many bars, as many as fit.
      let every = 1;
      while (pxQ * bq * every < 28 && every < 1e4) every *= 2;
      g.font = '11px ' + FONT;
      for (let k = Math.max(0, Math.floor(q0 / unit)); k * unit <= q1 + 1e-9 && k < 1e5; k++) {
        const q = k * unit, bar = Math.abs(q / bq - Math.round(q / bq)) < 1e-6, x = Math.round(xOf(tl.axisOfPos(q))) + 0.5;
        g.strokeStyle = bar ? rgba(C.ink, 0.35) : rgba(C.ink, 0.12);
        g.beginPath(); g.moveTo(x, TOP - 4); g.lineTo(x, axisY); g.stroke();
        if (bar && Math.round(q / bq) % every === 0) { g.fillStyle = C.ink; g.fillText(String(Math.round(q / bq) + 1), x + 3, axisY + 10); }
      }
    }
    // Transients: a line down the rows at each, in the markers' colour, faint enough for the notes
    // and the spectrogram to read through, for a note's start to be put on.
    if (app.notes.transients) {
      const M = app.markers;
      clipRows(L, R);
      g.strokeStyle = rgba(C.mark, 0.55);
      g.beginPath();
      for (let i = Math.max(0, lowerBound(M, tl.sourceAt(t0) - 1)); i < M.length; i++) {
        const a = tl.axisAt(M[i].t);
        if (a > t0 + span) break;
        if (a < t0) continue;
        const x = Math.round(xOf(a)) + 0.5;
        g.moveTo(x, TOP); g.lineTo(x, TOP + area);
      }
      g.stroke();
      g.restore();
    }
    // Notes: as long as they are held, darker the louder, lit while they sound; a bend drawn through
    // the note, a row a semitone. Over the spectrogram every note gets an edge, so it reads as a note
    // and not as a line of the picture.
    const ph = tl.axisAt(app.transport.playhead), sel = app.sel?.kind === 'note' ? app.sel : null;
    clipRows(L, R);
    const first = Math.max(0, lowerBound(notes, tl.sourceAt(t0 - 8)));
    const drawNote = (x0: number, x1: number, y: number, v: number, on: boolean, picked: boolean) => {
      const nh = Math.max(3, rh - 1);
      g.fillStyle = rgba(C.slice, 0.35 + 0.65 * v);
      g.beginPath(); if (g.roundRect) g.roundRect(x0, y + 0.5, x1 - x0, nh, 2); else g.rect(x0, y + 0.5, x1 - x0, nh); g.fill();
      if (on || picked || spec) { g.strokeStyle = on || picked ? C.ink : rgba(C.ink, 0.6); g.lineWidth = picked ? 2 : on ? 1.2 : 1; g.stroke(); g.lineWidth = 1; }
      return nh;
    };
    for (let i = first; i < notes.length && tl.axisAt(notes[i].t) < t0 + span; i++) {
      const n = notes[i], a = tl.axisAt(n.t), b = tl.axisAt(n.end);
      if (b < t0 || n.pitch > pTop || n.pitch < bottom) continue;
      const x0 = xOf(a), x1 = Math.max(x0 + 3, xOf(b)), y = yOf(n.pitch);
      const on = ph >= a && ph < b, picked = !!sel && sel.pitch === n.pitch && sel.t === n.t;
      const nh = drawNote(x0, x1, y, n.vel / 127, on, picked);
      if (n.bend?.length) {
        g.strokeStyle = rgba(C.ink, 0.6); g.lineWidth = 1.2; g.beginPath();
        g.moveTo(x0, y + rh / 2);
        for (const p of n.bend) g.lineTo(xOf(tl.axisAt(p.t)), y + rh / 2 - (p.cents / 100) * rh);
        g.stroke(); g.lineWidth = 1;
      }
      this.boxes.push({ x0, x1, y0: y, y1: y + nh, n });
    }
    const pv = this.preview;
    if (pv && pv.pitch <= pTop && pv.pitch >= bottom) {
      const x0 = xOf(tl.axisAt(pv.t)), x1 = Math.max(x0 + 3, xOf(tl.axisAt(pv.end)));
      drawNote(x0, x1, yOf(pv.pitch), 0.8, false, true);
    }
    g.restore();
    if (ph >= t0 && ph <= t0 + span) {
      const x = Math.round(xOf(ph)) + 0.5;
      g.strokeStyle = C.play; g.lineWidth = 1.5; g.beginPath(); g.moveTo(x, TOP - 6); g.lineTo(x, axisY); g.stroke(); g.lineWidth = 1;
    }
    g.restore();
    // Note names at the left: every C, and the lowest and highest rows, as far as there is room.
    g.font = '11px ' + FONT; g.fillStyle = C.dim;
    const every = rh >= 11 ? 1 : rh >= 5 ? 12 : 24;
    clipRows(0, LABEL_W);
    for (let p = bottom; p <= pTop; p++) {
      if (every === 1 ? !BLACK.has(p % 12) : p % every === 0) g.fillText(noteName(p), 4, yOf(p) + rh / 2);
    }
    g.restore();
    g.textAlign = 'center';
    const count = this.boxes.length, n0 = shown ? app.selectedNote() : null;
    const hint = app.notes.draw ? ' · Draw: drag to add' : '';
    g.fillText(!shown ? 'Notes hidden · N shows them' : n0 ? `${noteName(n0.pitch)} selected · Del deletes it` : `${count} note${count === 1 ? '' : 's'} ${loop ? 'in the loop' : 'in view'}${hint}`, (L + R) / 2, 8);
    g.textAlign = 'left'; g.font = '12px ' + FONT;
  }
}
