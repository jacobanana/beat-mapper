// A phase vocoder with identity phase locking (Laroche & Dolson, IEEE Trans. Speech and Audio
// Processing, 1999). Each output frame takes its magnitudes from the source where the warp says, and
// its phases are carried on from the frame before at each partial's own frequency, so a held chord
// stays in tune and continuous at any stretch. Only the peaks are carried on; every other bin keeps
// its phase relation to the peak it belongs to, which is what stops the "phasy", washed-out sound of
// the plain phase vocoder.
//
// A partial's frequency is measured from two frames a hop apart at the same spot in the source, rather
// than from the frame before, so it is right however the rate changes from one frame to the next.
// Stereo shares one set of phases, worked out on the mix, with each channel keeping its own offset
// from it: the image stays put instead of drifting, as it does when each side is stretched alone.
import { makeFFT } from '../dsp/fft';
import { type Pair, type Progress, addFrame, forwardPair, hann, inversePair, newPair, princarg, readFrame } from './frames';
import type { WarpMap } from './map';

export interface PvOptions {
  /** FFT size, a power of two. */
  N: number;
}

export function phaseVocoder(chans: readonly Float32Array[], sr: number, w: WarpMap, n: number, o: PvOptions, onProgress?: Progress): Float32Array[] {
  const { N } = o, H = N / 4, B = N / 2 + 1, half = N / 2, win = hann(N), fft = makeFFT(N), C = chans.length;
  const out = chans.map(() => new Float32Array(n));
  // Channels in pairs, each pair through one FFT.
  const G = Math.ceil(C / 2), now = Array.from({ length: G }, () => newPair(B)), before = newPair(B), Y = newPair(B);
  const re = new Float64Array(N), im = new Float64Array(N), fa = new Float64Array(N), fb = new Float64Array(N);
  const mr = new Float64Array(B), mi = new Float64Array(B), br = new Float64Array(B), bi = new Float64Array(B);
  const ph = new Float64Array(B), synth = new Float64Array(B), prevSynth = new Float64Array(B), mag = new Float64Array(B);
  const peakOf = new Int32Array(B), isPeak = new Uint8Array(B), rotR = new Float64Array(B), rotI = new Float64Array(B);
  const spec = (P: Pair, second: boolean) => (second ? [P.br, P.bi] : [P.ar, P.ai]);
  // Hann squared at a quarter-frame hop adds up to 1.5.
  const gain = 1 / 1.5;
  let first = true;
  const K0 = -3, K = Math.ceil(n / H) + 3;
  for (let k = K0; k <= K; k++) {
    const c = k * H, p = Math.round(w.srcAt(c / sr) * sr);
    // Every channel now, and the mix a hop earlier for each bin's frequency.
    mr.fill(0); mi.fill(0); br.fill(0); bi.fill(0);
    for (let g = 0; g < G; g++) {
      const a = chans[2 * g], b = chans[2 * g + 1];
      readFrame(a, p - half, win, fa);
      if (b) readFrame(b, p - half, win, fb);
      forwardPair(fft, fa, b ? fb : null, re, im, now[g]);
      if (!first) {
        readFrame(a, p - half - H, win, fa);
        if (b) readFrame(b, p - half - H, win, fb);
        forwardPair(fft, fa, b ? fb : null, re, im, before);
      }
      for (let kk = 0; kk < B; kk++) {
        mr[kk] += now[g].ar[kk] + (b ? now[g].br[kk] : 0); mi[kk] += now[g].ai[kk] + (b ? now[g].bi[kk] : 0);
        if (!first) { br[kk] += before.ar[kk] + (b ? before.br[kk] : 0); bi[kk] += before.ai[kk] + (b ? before.bi[kk] : 0); }
      }
    }
    for (let b = 0; b < B; b++) { mag[b] = Math.hypot(mr[b], mi[b]); ph[b] = Math.atan2(mi[b], mr[b]); }
    if (first) {
      synth.set(ph);
      first = false;
    } else {
      findPeaks(mag, isPeak, peakOf);
      for (let b = 0; b < B; b++) {
        if (!isPeak[b]) continue;
        const omega = (2 * Math.PI * b) / N, f = omega + princarg(ph[b] - Math.atan2(bi[b], br[b]) - omega * H) / H;
        synth[b] = princarg(prevSynth[b] + f * H);
      }
      for (let b = 0; b < B; b++) { const pk = peakOf[b]; if (pk !== b) synth[b] = synth[pk] + ph[b] - ph[pk]; }
    }
    prevSynth.set(synth);
    // Each channel is turned by the same angle, from the mix's phase to the new one: it keeps its own
    // offset from the mix, with one cos and sin per bin rather than per bin and channel.
    for (let b = 0; b < B; b++) {
      const m = mag[b] || 1, cs = Math.cos(synth[b]), sn = Math.sin(synth[b]), ur = mr[b] / m, ui = -mi[b] / m;
      rotR[b] = mag[b] ? cs * ur - sn * ui : cs; rotI[b] = mag[b] ? cs * ui + sn * ur : sn;
    }
    for (let g = 0; g < G; g++) {
      for (const second of [false, true]) {
        const [xr, xi] = spec(now[g], second), [yr, yi] = spec(Y, second);
        for (let b = 0; b < B; b++) { yr[b] = xr[b] * rotR[b] - xi[b] * rotI[b]; yi[b] = xr[b] * rotI[b] + xi[b] * rotR[b]; }
        if (!chans[2 * g + 1]) break;
      }
      if (!chans[2 * g + 1]) { Y.br.fill(0); Y.bi.fill(0); }
      inversePair(fft, Y, re, im);
      for (let i = 0; i < N; i++) { re[i] *= win[i]; im[i] *= win[i]; }
      addFrame(out[2 * g], c - half, re, gain);
      if (chans[2 * g + 1]) addFrame(out[2 * g + 1], c - half, im, gain);
    }
    if ((k & 31) === 0) onProgress?.((k - K0) / (K - K0));
  }
  return out;
}

// A peak is a bin louder than two neighbours either side. Every bin belongs to the peak on its side of
// the quietest bin between two peaks, as Laroche & Dolson's regions of influence.
function findPeaks(mag: Float64Array, isPeak: Uint8Array, peakOf: Int32Array): void {
  const B = mag.length, peaks: number[] = [];
  isPeak.fill(0);
  for (let b = 2; b < B - 2; b++) {
    const m = mag[b];
    if (m > mag[b - 1] && m > mag[b - 2] && m >= mag[b + 1] && m >= mag[b + 2]) { isPeak[b] = 1; peaks.push(b); }
  }
  if (!peaks.length) {
    // Silence or noise with no clear peak: every bin carries its own phase on.
    for (let b = 0; b < B; b++) { isPeak[b] = 1; peakOf[b] = b; }
    return;
  }
  let start = 0;
  for (let i = 0; i < peaks.length; i++) {
    const pk = peaks[i];
    let end = B;
    if (i + 1 < peaks.length) {
      const nx = peaks[i + 1];
      let lo = pk;
      for (let b = pk; b <= nx; b++) if (mag[b] < mag[lo]) lo = b;
      end = lo;
    }
    for (let b = start; b < end; b++) peakOf[b] = pk;
    start = end;
  }
}
