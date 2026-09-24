import { resample } from '../../core/dsp/resample';

/** The sample rates a .wav can be written at, besides the audio's own. */
export const WAV_RATES = [44100, 48000, 88200, 96000] as const;

export interface WavOptions {
  bits: 16 | 24;
  /** The rate the file is written at; null keeps the audio's own. */
  rate: number | null;
  /** Triangular dither before the rounding to `bits`, so quiet tails fade into noise, not steps. */
  dither: boolean;
}

/**
 * PCM WAV, interleaved, 16 or 24-bit. Dithered, one LSB of triangular noise (the sum of two uniform
 * ones) goes on each sample before it is rounded; the noise comes from a fixed-seed generator, so the
 * same audio always writes the same bytes.
 */
export function wavEncode(chans: readonly Float32Array[], sr: number, bits: 16 | 24 = 16, dither = false): Uint8Array {
  const ch = chans.length, n = chans[0].length, bps = bits === 24 ? 3 : 2, dataLen = n * ch * bps;
  const out = new Uint8Array(44 + dataLen), v = new DataView(out.buffer);
  const W = (p: number, str: string) => { for (let i = 0; i < str.length; i++) out[p + i] = str.charCodeAt(i); };
  W(0, 'RIFF'); v.setUint32(4, 36 + dataLen, true); W(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * ch * bps, true); v.setUint16(32, ch * bps, true); v.setUint16(34, bits === 24 ? 24 : 16, true);
  W(36, 'data'); v.setUint32(40, dataLen, true);
  let p = 44, seed = 0x9e3779b9;
  const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
  const tpdf = dither ? () => rnd() + rnd() - 1 : () => 0;
  if (bits === 24) {
    for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) {
      const q = Math.max(-8388607, Math.min(8388607, Math.round(chans[c][i] * 8388607 + tpdf())));
      out[p] = q & 255; out[p + 1] = (q >> 8) & 255; out[p + 2] = (q >> 16) & 255; p += 3;
    }
  } else {
    for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) {
      v.setInt16(p, Math.max(-32767, Math.min(32767, Math.round(chans[c][i] * 32767 + tpdf()))), true); p += 2;
    }
  }
  return out;
}

/** The audio, at `sr`, as a .wav written the way the options say: resampled if another rate is asked for. */
export function wavFile(chans: readonly Float32Array[], sr: number, o: WavOptions): Uint8Array {
  const rate = o.rate ?? sr;
  return wavEncode(rate === sr ? chans : resample(chans, sr, rate), rate, o.bits, o.dither);
}

/** Rough size of a WAV holding `samples` frames. */
export const wavSize = (samples: number, channels: number, bits: 16 | 24): number => samples * channels * (bits / 8) + 44;
