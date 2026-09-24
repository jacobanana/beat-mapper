// Pointer input on the editor canvas. Where a touch lands decides what it does (see layout.ts):
// the loop strip draws loops, the bar ruler drags pins, the upper half of the waveform edits, the
// lower half scrolls, and the time ruler scrubs. In the Warp step the upper half drags transients
// onto the grid. In the Groove step the whole waveform is the drum
// lanes, where hits are dragged, added and deleted.
import type { App, Hover } from '../../app/app';
import type { Features } from '../../app/features';
import { lowerBound } from '../../core/search';
import type { TimeRange } from '../../core/types';
import type { EditorRenderer } from '../canvas/editor-renderer';
import { type Zone, laneAt, zoneAt } from '../canvas/layout';

type Hit = Exclude<Hover, null>;
interface LoopDrag { mode: 'a' | 'b' | 'move' | 'new'; orig: TimeRange | null; t0: number }
interface Drag {
  x0: number;
  moved: boolean;
  hit: Hit | null;
  v0: { t0: number; t1: number };
  zone: Zone;
  touch: boolean;
  scrub: boolean;
  loop: LoopDrag | null;
  /** Scrub position, for scrolling at the edges. */
  x: number;
  /** Id of the placed hit being dragged, once a drag on a drum hit has begun. */
  hitId?: number;
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export class PointerInput {
  private drag: Drag | null = null;
  private pinch: { d: number; mid: number; t0: number; t1: number } | null = null;
  private readonly ptrs = new Map<number, { x: number; y: number }>();
  private lastClick = { t: 0, x: 0 };

  constructor(
    private readonly cv: HTMLCanvasElement,
    private readonly ov: HTMLCanvasElement,
    private readonly app: App,
    private readonly f: Features,
    private readonly renderer: EditorRenderer,
  ) {
    cv.addEventListener('pointerdown', (e) => this.down(e));
    cv.addEventListener('pointermove', (e) => this.move(e));
    cv.addEventListener('pointerup', (e) => this.up(e));
    cv.addEventListener('pointercancel', (e) => this.up(e));
    cv.addEventListener('pointerleave', () => { if (app.hover) { app.hover = null; app.bus.emit('hover'); } });
    cv.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    this.bindOverview();
  }

  get busy(): boolean { return this.drag != null || this.pinch != null; }

  private local(e: MouseEvent): [number, number] {
    const b = this.cv.getBoundingClientRect();
    return [e.clientX - b.left, e.clientY - b.top];
  }

  // The audio under x, and where the audio at t is: in Warp it is drawn moved onto the grid.
  private tOf(x: number): number { return this.app.sourceAt(this.app.view.tOf(x)); }
  private xOf(t: number): number { return this.app.view.xOf(this.app.shownAt(t)); }

  // ---------- hit testing ----------
  private hitTest(x: number, y: number, touch: boolean): Hit | null {
    const { app } = this, r = touch ? 14 : 6;
    if (!app.audio) return null;
    if (app.step === 5) {
      const voice = laneAt(this.renderer.layout(), y), H = voice && app.drumHits?.[voice];
      if (!voice || !H) return null;
      let best = null, bd = r + 1;
      for (let i = lowerBound(H, this.tOf(x - r - 1)); i < H.length; i++) {
        const xh = this.xOf(H[i].t), d = Math.abs(xh - x);
        if (xh > x + r) break;
        if (d < bd) { bd = d; best = H[i]; }
      }
      return best ? { kind: 'hit', voice, t: best.t } : null;
    }
    if (app.step === 1) {
      const M = app.markers;
      let best = null, bd = r + 1;
      for (let i = lowerBound(M, this.tOf(x - r - 1)); i < M.length; i++) {
        const xm = this.xOf(M[i].t), d = Math.abs(xm - x);
        if (xm > x + r) break;
        if (d < bd) { bd = d; best = M[i]; }
      }
      return best ? { kind: 'marker', id: best.id } : null;
    }
    if (app.step === 3 && app.hasMap) {
      // A transient, or a warp marker that no longer has one under it (the sensitivity changed).
      let best: number | null = null, bd = r + 1;
      const M = app.markers, near = (t: number) => { const d = Math.abs(this.xOf(t) - x); if (d < bd) { bd = d; best = t; } };
      for (let i = lowerBound(M, this.tOf(x - r - 1)); i < M.length && this.xOf(M[i].t) <= x + r; i++) near(M[i].t);
      for (const w of app.doc.warpMarkers) near(w.t);
      return best == null ? null : { kind: 'warp', t: best };
    }
    if (app.step === 2 && app.hasMap) {
      const map = app.tempoMap;
      let best = null, bd = r + 1;
      for (const a of map.anchors) { const d = Math.abs(this.xOf(a.t) - x); if (d < bd) { bd = d; best = a; } }
      if (best) return { kind: 'anchor', q: best.q };
      const q = app.grid.nearest(map.timeToPos(this.tOf(x)), this.renderer.visLevel);
      if (q > 1e-6 && Math.abs(this.xOf(map.posToTime(q)) - x) <= r) return { kind: 'grid', q };
    }
    return null;
  }

  private zoneHit(x: number, y: number, zone: Zone, touch: boolean): Hit | null {
    if (this.app.transport.scrubMode || (zone !== 'edit' && zone !== 'bars')) return null;
    const h = this.hitTest(x, y, touch);
    return h && zone === 'bars' && h.kind !== 'anchor' && h.kind !== 'grid' && h.kind !== 'warp' ? null : h;
  }

  private loopHit(x: number, r: number): 'a' | 'b' | 'move' | null {
    const L = this.app.transport.loop;
    if (!L) return null;
    const xa = this.xOf(L.a), xb = this.xOf(L.b);
    if (Math.abs(x - xa) <= r && Math.abs(x - xa) <= Math.abs(x - xb)) return 'a';
    if (Math.abs(x - xb) <= r) return 'b';
    if (x > xa && x < xb) return 'move';
    return null;
  }

  // The magnet. Transients pull from a few pixels away, since dragging past the nearest hit has to stay
  // possible; the grid takes whatever is dropped on it, at the resolution the grid select is set to. Alt
  // flips the magnet: it bypasses one that is set, and reaches for the transients when none is.
  // Pins are the exception: they are what makes the grid, so grid lines would chase a pin being dragged.
  private snapT(x: number, touch: boolean, bypass: boolean, noGrid = false): number {
    const t = this.tOf(x), set = this.app.beats.snapTo;
    const mode = !bypass ? set : set === 'off' ? 'markers' : 'off';
    if (mode === 'grid') return noGrid ? t : this.f.playback.gridSnap(t);
    if (mode !== 'markers') return t;
    const r = touch ? 14 : 9, M = this.app.markers;
    let best: number | null = null, bd = r;
    for (let i = lowerBound(M, this.tOf(x - r)); i < M.length && this.xOf(M[i].t) <= x + r; i++) {
      const d = Math.abs(this.xOf(M[i].t) - x);
      if (d <= bd) { bd = d; best = M[i].t; }
    }
    return best == null ? t : best;
  }

  // Drum hits land on the transients: dragged, within a few pixels, as the magnet pulls; placed, within
  // 30 ms too, since a double tap on a phone is rarely closer than that. Alt places them freely.
  private hitT(x: number, touch: boolean, bypass: boolean, placing: boolean): number {
    const t = this.tOf(x), px = (touch ? 14 : 9) * (this.app.view.span / this.app.view.width);
    return bypass ? t : this.f.groove.alignToTransient(t, placing ? Math.max(px, 0.03) : px);
  }

  // In Beats the playhead follows the magnet, so it can be dropped exactly on a beat or a transient.
  // Elsewhere a tap lands where it is aimed – in Transients that is where the next marker goes.
  private tapT(x: number, d: Drag, e: PointerEvent): number {
    return this.app.step === 2 ? this.snapT(x, d.touch, e.altKey) : this.tOf(x);
  }

  // ---------- events ----------
  private down(e: PointerEvent): void {
    const { app } = this;
    if (!app.audio) return;
    this.cv.focus({ preventScroll: true });
    this.cv.setPointerCapture(e.pointerId);
    const [x, y] = this.local(e);
    this.ptrs.set(e.pointerId, { x, y });
    if (this.ptrs.size === 2) {
      const p = [...this.ptrs.values()];
      this.pinch = { d: Math.abs(p[0].x - p[1].x) || 1, mid: (p[0].x + p[1].x) / 2, t0: app.view.t0, t1: app.view.t1 };
      this.f.warp.cancelDrag();
      this.endDrag();
      return;
    }
    const touch = e.pointerType === 'touch', r = touch ? 14 : 7, zone = zoneAt(this.renderer.layout(), y, app.step);
    const body = zone === 'edit' || zone === 'nav', hit = this.zoneHit(x, y, zone, touch);
    const d: Drag = {
      x0: x, x, moved: false, hit, v0: { t0: app.view.t0, t1: app.view.t1 }, zone, touch, loop: null,
      scrub: zone === 'time' || (app.transport.scrubMode && body && !e.shiftKey),
    };
    const orig = app.transport.loop && { ...app.transport.loop };
    if (zone === 'loop') d.loop = { mode: this.loopHit(x, r) || 'new', orig, t0: this.snapT(x, touch, e.altKey) };
    else if (body && e.shiftKey && !hit) d.loop = { mode: 'new', orig, t0: this.snapT(x, touch, e.altKey) };
    this.drag = d;
    app.dragging = true;
    if (d.scrub) this.f.playback.scrubStart(this.tOf(x));
  }

  private endDrag(): void {
    if (this.drag?.scrub) this.f.playback.scrubEnd();
    this.drag = null;
    this.app.dragging = false;
  }

  private move(e: PointerEvent): void {
    const { app } = this, [x, y] = this.local(e);
    if (this.ptrs.has(e.pointerId)) this.ptrs.set(e.pointerId, { x, y });
    if (this.pinch && this.ptrs.size === 2) {
      const p = [...this.ptrs.values()], P = this.pinch, W = app.view.width;
      const d = Math.abs(p[0].x - p[1].x) || 1, mid = (p[0].x + p[1].x) / 2, span0 = P.t1 - P.t0;
      const span = clamp((span0 * P.d) / d, Math.min(0.004, app.dur), app.dur), tc = P.t0 + (P.mid / W) * span0;
      app.setView(tc - (mid / W) * span, tc - (mid / W) * span + span);
      return;
    }
    const d = this.drag;
    if (!d) return this.hover(x, y);
    if (d.scrub) { d.moved = true; d.x = x; this.f.playback.scrubTo(this.tOf(x)); return; }
    if (!d.moved) {
      if (Math.abs(x - d.x0) < 4) return;
      d.moved = true;
      if (d.loop) { if (d.loop.mode === 'new') app.transport.loopOn = true; }
      else if (d.hit) this.beginEdit(d);
    }
    const h = d.hit;
    if (d.loop) this.dragLoop(d.loop, x, d, e);
    else if (!h) {
      const dt = ((x - d.x0) / app.view.width) * (d.v0.t1 - d.v0.t0);
      app.setView(d.v0.t0 - dt, d.v0.t1 - dt);
    } else if (h.kind === 'marker') this.f.markers.moveTo(h.id, this.tOf(x));
    else if (h.kind === 'hit') { if (d.hitId != null) d.hit = { ...h, t: this.f.groove.moveHitTo(d.hitId, this.hitT(x, d.touch, e.altKey, false)) }; }
    else if (h.kind === 'anchor') this.f.beats.dragTo(h.q, this.snapT(x, d.touch, e.altKey, true));
    else if (h.kind === 'warp') this.f.warp.dragTo(this.tOf(x), e.altKey);
  }

  /** The first move of a drag on something: it becomes an edit, checkpointed once for undo. */
  private beginEdit(d: Drag): void {
    const { app, f } = this, h = d.hit!;
    if (h.kind === 'marker') {
      const m = app.markers.find((k) => k.id === h.id);
      if (!m) return;
      app.checkpoint();
      d.hit = { kind: 'marker', id: f.markers.toManual(m) };
      app.select(d.hit);
    } else if (h.kind === 'hit') {
      app.checkpoint();
      d.hitId = f.groove.toManual(h.voice, h.t);
      app.select(h);
    } else if (h.kind === 'warp') {
      f.warp.grab(h.t);
      app.hover = null;
    } else if (h.kind === 'grid' || h.kind === 'anchor') {
      d.hit = { kind: 'anchor', q: f.beats.beginDrag(h.q, h.kind === 'grid') };
      app.hover = null;
    }
  }

  private dragLoop(L: LoopDrag, x: number, d: Drag, e: PointerEvent): void {
    const { app } = this, t = this.snapT(x, d.touch, e.altKey), dur = app.dur;
    let loop: TimeRange;
    if (L.mode === 'new') loop = { a: Math.min(L.t0, t), b: Math.max(L.t0, t) };
    else if (L.mode === 'move') {
      const len = L.orig!.b - L.orig!.a, a = clamp(L.orig!.a + (this.tOf(x) - this.tOf(d.x0)), 0, dur - len);
      loop = { a, b: a + len };
    } else if (L.mode === 'a') loop = { a: Math.min(t, L.orig!.b - 0.01), b: L.orig!.b };
    else loop = { a: L.orig!.a, b: Math.max(t, L.orig!.a + 0.01) };
    app.transport.loop = { a: clamp(loop.a, 0, dur), b: clamp(loop.b, 0, dur) };
    app.bus.emit('transport');
  }

  private hover(x: number, y: number): void {
    const { app } = this, zone = zoneAt(this.renderer.layout(), y, app.step), h = this.zoneHit(x, y, zone, false), cur = app.hover;
    const same = (h === null && cur === null) || (h !== null && cur !== null && h.kind === cur.kind && JSON.stringify(h) === JSON.stringify(cur));
    if (!same) { app.hover = h; app.bus.emit('hover'); }
    const lh = zone === 'loop' ? this.loopHit(x, 7) : null;
    this.cv.style.cursor = h || lh === 'a' || lh === 'b' ? 'ew-resize' : lh === 'move' ? 'grab' : zone === 'loop' ? 'crosshair'
      : zone === 'time' || app.transport.scrubMode ? 'col-resize' : zone === 'nav' ? 'grab' : 'default';
  }

  private up(e: PointerEvent): void {
    const { app, f } = this;
    this.ptrs.delete(e.pointerId);
    if (this.pinch) { if (this.ptrs.size < 2) this.pinch = null; this.endDrag(); return; }
    const d = this.drag;
    if (!d) return;
    this.endDrag();
    const [x] = this.local(e);
    if (d.scrub) { app.bus.emit('playhead'); return; }
    if (d.moved && d.loop) {
      const L = app.transport.loop;
      f.playback.setLoop(L && L.b - L.a < 0.01 ? d.loop.orig : L);
      return;
    }
    if (d.moved) {
      const h = d.hit;
      if (h?.kind === 'marker') {
        f.markers.settle();
        app.select(h);
        const m = app.selectedMarker();
        if (m) f.playback.seek(m.t, true);
      } else if (h?.kind === 'anchor') {
        const a = app.doc.tempo.anchors.find((k) => k.q === h.q);
        if (a) f.playback.seek(a.t, true);
      } else if (h?.kind === 'hit') f.playback.seek(h.t, true);
      else if (h?.kind === 'warp') f.warp.drop();
      app.bus.emit('doc');
      return;
    }
    const now = performance.now(), dbl = now - this.lastClick.t < 350 && Math.abs(x - this.lastClick.x) < 8;
    this.lastClick = { t: dbl ? 0 : now, x };
    this.tap(x, this.local(e)[1], d, e, dbl);
  }

  /** A tap or double tap (no drag). */
  private tap(x: number, y: number, d: Drag, e: PointerEvent, dbl: boolean): void {
    const { app, f } = this, t = this.tOf(x);
    if (d.zone === 'loop') {
      const lh = this.loopHit(x, d.touch ? 14 : 7);
      if (dbl && !lh) f.playback.loopBarAt(t);
      else if (lh && !dbl) f.playback.setLoop(app.transport.loop, !app.transport.loopOn);
      else if (!lh) f.playback.seek(this.tapT(x, d, e));
      return;
    }
    if (dbl && (d.zone === 'edit' || d.zone === 'bars') && !app.transport.scrubMode) {
      const h = d.hit;
      if (app.step === 1 && d.zone === 'edit') {
        const m = h?.kind === 'marker' ? app.markers.find((k) => k.id === h.id) : undefined;
        if (m) f.markers.remove(m); else f.markers.add(t);
      } else if (app.step === 5 && d.zone === 'edit') {
        const voice = laneAt(this.renderer.layout(), y);
        if (h?.kind === 'hit') f.groove.removeHit(h.voice, h.t);
        else if (voice) f.groove.addHit(voice, this.hitT(x, d.touch, e.altKey, true));
      } else if (app.step === 3) {
        if (h?.kind === 'warp') { if (f.warp.isMarker(h.t)) f.warp.remove(h.t); else f.warp.snap(h.t); }
      } else if (app.step === 2) {
        if (h?.kind === 'anchor') { const a = app.doc.tempo.anchors.find((k) => k.q === h.q); if (a) f.beats.unpin(a); }
        else if (h?.kind === 'grid') f.beats.pinAt(app.tempoMap.posToTime(h.q), h.q);
        else if (d.zone === 'edit') f.beats.pinAt(t);
      }
      return;
    }
    if (app.step === 4 && (d.zone === 'edit' || d.zone === 'nav') && !app.transport.scrubMode) {
      const i = f.slicer.at(t);
      if (i >= 0) {
        f.slicer.select(i);
        if (dbl) { f.playback.stopPreview(); f.slicer.toggle(i); }
        else { f.playback.seek(app.slices[i].t0, true); f.slicer.preview(i); }
        return;
      }
    }
    const h = d.hit;
    const target = h?.kind === 'marker' ? app.markers.find((k) => k.id === h.id) : h?.kind === 'anchor' ? app.doc.tempo.anchors.find((k) => k.q === h.q) : h?.kind === 'hit' || h?.kind === 'warp' ? h : undefined;
    if (h && target && h.kind !== 'grid') { app.select(h); f.playback.seek(target.t); }
    else { app.select(null); f.playback.seek(this.tapT(x, d, e)); }
  }

  private wheel(e: WheelEvent): void {
    const { app } = this;
    if (!app.audio) return;
    e.preventDefault();
    const [x] = this.local(e), sp = app.view.span, unit = e.deltaMode === 1 ? 16 : 1;
    if (!e.shiftKey && (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) >= Math.abs(e.deltaX))) {
      app.view.zoomAt(Math.exp(clamp(e.deltaY * unit, -120, 120) * (e.ctrlKey ? 0.01 : 0.0028)), app.view.tOf(x));
      app.bus.emit('view');
    } else {
      const d = (((Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) * unit) / app.view.width) * sp;
      app.setView(app.view.t0 + d, app.view.t1 + d);
    }
  }

  /** Dragging on the overview strip centres the view there. */
  private bindOverview(): void {
    const { ov, app } = this;
    let on = false;
    const go = (e: PointerEvent) => {
      const b = ov.getBoundingClientRect(), t = ((e.clientX - b.left) / b.width) * app.dur, sp = app.view.span;
      app.setView(t - sp / 2, t + sp / 2);
    };
    ov.addEventListener('pointerdown', (e) => { if (!app.audio) return; ov.setPointerCapture(e.pointerId); on = true; go(e); });
    ov.addEventListener('pointermove', (e) => { if (on) go(e); });
    ov.addEventListener('pointerup', () => (on = false));
    ov.addEventListener('pointercancel', () => (on = false));
  }

  /** Every frame: while scrubbing near an edge, the view scrolls along. */
  tick(): void {
    const d = this.drag, { app } = this;
    if (!d || !d.scrub) return;
    const w = app.view.width, sp = app.view.span, dir = d.x < 24 ? -1 : d.x > w - 24 ? 1 : 0;
    if (!dir) return;
    app.setView(app.view.t0 + dir * sp * 0.012, app.view.t1 + dir * sp * 0.012);
    this.f.playback.scrubTo(this.tOf(d.x));
  }
}
