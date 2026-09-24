import type { AudioAsset } from '../../app/audio-asset';
import type { WarpView } from '../../core/warp/markers';

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/**
 * Draws t0..t1 of the audio into canvas c at wpx×hpx device pixels. Zoomed out it is a min/max bar
 * per pixel; zoomed in, a line through the samples, with dots once they are far apart. With a warp
 * view, t0..t1 is where things are drawn and the audio is drawn where the warp moves it.
 */
export function renderWave(
  c: HTMLCanvasElement, a: AudioAsset, t0: number, t1: number, wpx: number, hpx: number, amp: number, color: string, dpr: number,
  wv: WarpView | null = null,
): void {
  c.width = wpx;
  c.height = hpx;
  const k = c.getContext('2d')!;
  k.clearRect(0, 0, wpx, hpx);
  const shown = wv ? wv.shown : (t: number) => t, source = wv ? wv.source : (t: number) => t;
  const x = a.x, sr = a.sr, mid = hpx / 2, sc = ((hpx / 2 - 3 * dpr) * amp) / a.peak, s0t = source(t0), s1t = source(t1), spp = ((s1t - s0t) * sr) / wpx;
  const pxOf = (s: number) => ((shown(s / sr) - t0) / (t1 - t0)) * wpx;
  k.fillStyle = color;
  k.strokeStyle = color;
  if (spp < 1.5) {
    k.lineWidth = 1.2 * dpr;
    k.beginPath();
    const s0 = Math.max(0, Math.floor(s0t * sr) - 1), s1 = Math.min(x.length - 1, Math.ceil(s1t * sr) + 1);
    for (let s = s0; s <= s1; s++) {
      const px = pxOf(s), py = mid - x[s] * sc;
      if (s === s0) k.moveTo(px, py); else k.lineTo(px, py);
    }
    k.stroke();
    if (spp < 0.12) for (let s = s0; s <= s1; s++) { const px = pxOf(s); k.fillRect(px - 1.5 * dpr, mid - x[s] * sc - 1.5 * dpr, 3 * dpr, 3 * dpr); }
  } else {
    for (let px = 0; px < wpx; px++) {
      const m = a.peaks.minmax(Math.floor(source(t0 + ((t1 - t0) * px) / wpx) * sr), Math.ceil(source(t0 + ((t1 - t0) * (px + 1)) / wpx) * sr));
      if (!m) continue;
      const y0 = mid - clamp(m[1] * sc, -mid, mid), y1 = mid - clamp(m[0] * sc, -mid, mid);
      k.fillRect(px, y0, 1, Math.max(1, y1 - y0));
    }
  }
}
