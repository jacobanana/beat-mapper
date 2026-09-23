import { describe, expect, it, vi } from 'vitest';
import { Emitter } from '../src/state/emitter';
import { History } from '../src/state/history';
import { memo } from '../src/state/memo';
import { Viewport } from '../src/state/viewport';
import { addManual, emptyDoc, moveManual, removeCandidate, withAnchors } from '../src/state/project';

describe('History', () => {
  it('undoes and redoes snapshots, and a new edit clears redo', () => {
    const h = new History<number>(3);
    h.record(1); h.record(2);
    expect(h.undo(3)).toBe(2);
    expect(h.redo(2)).toBe(3);
    expect(h.undo(3)).toBe(2);
    h.record(2);
    expect(h.canRedo).toBe(false);
  });

  it('keeps at most `limit` steps', () => {
    const h = new History<number>(2);
    h.record(1); h.record(2); h.record(3);
    expect(h.undo(4)).toBe(3);
    expect(h.undo(3)).toBe(2);
    expect(h.undo(2)).toBeNull();
  });
});

describe('memo', () => {
  it('recomputes only when a dependency changes identity', () => {
    const fn = vi.fn((a: object, n: number) => ({ a, n }));
    const m = memo(fn), o = {};
    const r1 = m(o, 1);
    expect(m(o, 1)).toBe(r1);
    expect(m({}, 1)).not.toBe(r1);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('Emitter', () => {
  it('calls each listener once per emit, and * hears everything', () => {
    const e = new Emitter<'a' | 'b'>(), seen: string[] = [];
    e.on(['a', 'b'], (t) => seen.push('ab:' + t));
    const off = e.on('*', (t) => seen.push('*:' + t));
    e.emit('a', 'b');
    expect(seen).toEqual(['ab:a', '*:a']);
    off();
    e.emit('b');
    expect(seen).toEqual(['ab:a', '*:a', 'ab:b']);
  });
});

describe('Viewport', () => {
  it('maps time to pixels and back', () => {
    const v = new Viewport();
    v.reset(10); v.width = 500;
    expect(v.xOf(5)).toBe(250);
    expect(v.tOf(250)).toBe(5);
  });

  it('stays inside the audio and no narrower than 4 ms', () => {
    const v = new Viewport();
    v.reset(10);
    v.set(-2, 3);
    expect([v.t0, v.t1]).toEqual([0, 5]);
    v.set(9, 12);
    expect([v.t0, v.t1]).toEqual([7, 10]);
    v.set(1, 1);
    expect(v.span).toBeCloseTo(0.004);
  });

  it('zooms around a point and reveals times off screen', () => {
    const v = new Viewport();
    v.reset(10); v.width = 100;
    v.zoomAt(0.5, 5);
    expect([v.t0, v.t1]).toEqual([2.5, 7.5]);
    v.reveal(9);
    expect(v.contains(9)).toBe(true);
  });
});

describe('project document', () => {
  it('is never mutated by edits', () => {
    const d0 = emptyDoc();
    const [d1, id] = addManual(d0, 1.5);
    const d2 = moveManual(d1, id, 2);
    const d3 = removeCandidate(withAnchors(d2, [{ q: 4, t: 2, manual: true }, { q: 0, t: 0.1, manual: true }]), 3.3);
    expect(d0.markers.manual).toEqual([]);
    expect(d1.markers.manual).toEqual([{ id: 1, t: 1.5 }]);
    expect(d2.markers.manual).toEqual([{ id: 1, t: 2 }]);
    expect(d3.tempo.anchors.map((a) => a.q)).toEqual([0, 4]);
    expect(d3.markers.removed).toEqual([3.3]);
    expect(removeCandidate(d3, 3.3)).toBe(d3);
  });
});
