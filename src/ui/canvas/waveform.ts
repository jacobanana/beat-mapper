import type { AudioAsset } from '../../app/audio-asset';
import type { Timeline } from '../../core/timeline';

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/**
 * Draws t0..t1 of the audio into canvas c at wpx×hpx device pixels. Zoomed out it is a min/max bar
 * per pixel; zoomed in, a line through the samples, with dots once they are far apart. With a timeline
 * that moves the audio, t0..t1 is a stretch of its axis and the audio is drawn where it puts it: in
 * Drums mode that is piece by piece, so a cut-off tail is not drawn and a gap is left empty.
 */
export function renderWave(
  c: HTMLCanvasElement, a: AudioAsset, t0: number, t1: number, wpx: number, hpx: number, amp: number, color: string, dpr: number,
  tl: Timeline | null = null,
): void {
  c.width = wpx;
  c.height = hpx;
  const k = c.getContext('2d')!;
  k.clearRect(0, 0, wpx, hpx);
  const shown = (t: number) => (tl ? tl.axisAt(t) : t), heard = (u0: number, u1: number): [number, number][] => (tl ? tl.heard(u0, u1) : [[u0, u1]]);
  const x = a.x, sr = a.sr, mid = hpx / 2, sc = ((hpx / 2 - 3 * dpr) * amp) / a.peak, spans = heard(t0, t1);
  if (!spans.length) return;
  const spp = ((spans.reduce((n, [u0, u1]) => n + u1 - u0, 0) || t1 - t0) * sr) / wpx;
  const pxOf = (s: number) => ((shown(s / sr) - t0) / (t1 - t0)) * wpx;
  k.fillStyle = color;
  k.strokeStyle = color;
  if (spp < 1.5) {
    k.lineWidth = 1.2 * dpr;
    k.beginPath();
    // A line per stretch heard: a cut starts a new one rather than joining across the gap. The first
    // and last reach a sample past the view, so the line runs to its edges.
    const ends = spans.map(([u0, u1], i): [number, number] => [
      Math.max(0, i === 0 ? Math.floor(u0 * sr) - 1 : Math.ceil(u0 * sr)),
      Math.min(x.length - 1, i === spans.length - 1 ? Math.ceil(u1 * sr) + 1 : Math.floor(u1 * sr)),
    ]);
    for (const [s0, s1] of ends) {
      for (let s = s0; s <= s1; s++) {
        const px = pxOf(s), py = mid - x[s] * sc;
        if (s === s0) k.moveTo(px, py); else k.lineTo(px, py);
      }
    }
    k.stroke();
    if (spp < 0.12) for (const [s0, s1] of ends) for (let s = s0; s <= s1; s++) { const px = pxOf(s); k.fillRect(px - 1.5 * dpr, mid - x[s] * sc - 1.5 * dpr, 3 * dpr, 3 * dpr); }
  } else {
    for (let px = 0; px < wpx; px++) {
      let lo = Infinity, hi = -Infinity;
      for (const [u0, u1] of heard(t0 + ((t1 - t0) * px) / wpx, t0 + ((t1 - t0) * (px + 1)) / wpx)) {
        const m = a.peaks.minmax(Math.floor(u0 * sr), Math.ceil(u1 * sr));
        if (m) { lo = Math.min(lo, m[0]); hi = Math.max(hi, m[1]); }
      }
      if (lo > hi) continue;
      const y0 = mid - clamp(hi * sc, -mid, mid), y1 = mid - clamp(lo * sc, -mid, mid);
      k.fillRect(px, y0, 1, Math.max(1, y1 - y0));
    }
  }
}
