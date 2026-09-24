import { describe, expect, it } from 'vitest';
import { resample } from '../src/core/dsp/resample';
import { WAV_RATES, wavEncode, wavFile } from '../src/io/formats/wav';

const sine = (sr: number, hz: number, secs: number, amp = 0.5) => Float32Array.from({ length: Math.round(sr * secs) }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / sr));
const i16 = (b: Uint8Array) => new Int16Array(b.buffer, 44, (b.length - 44) / 2);
const rms = (x: ArrayLike<number>, a: number, b: number) => { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(s / (b - a)); };

describe('resampling', () => {
  it('keeps a tone below both Nyquists, at its level, at every rate offered', () => {
    for (const from of [44100, 48000]) for (const to of WAV_RATES) {
      const x = sine(from, 1000, 0.5), y = resample([x], from, to)[0];
      expect(y.length).toBe(Math.round(x.length * (to / from)));
      // Away from the ends (the kernel reads silence past them), each output sample is the tone itself.
      let err = 0;
      for (let i = 200; i < y.length - 200; i++) err = Math.max(err, Math.abs(y[i] - 0.5 * Math.sin((2 * Math.PI * 1000 * i) / to)));
      expect(err, `${from} → ${to}`).toBeLessThan(2e-3);
    }
  });

  it('takes out what lies above the new Nyquist instead of folding it back', () => {
    const x = sine(96000, 40000, 0.5), y = resample([x], 96000, 44100)[0];
    expect(rms(y, 500, y.length - 500)).toBeLessThan(1e-3);
  });

  it('hands the same samples back at the same rate, and follows every channel', () => {
    const l = sine(48000, 440, 0.1), r = sine(48000, 880, 0.1);
    expect(resample([l, r], 48000, 48000)).toEqual([l, r]);
    const [a, b] = resample([l, r], 48000, 44100);
    expect(a.length).toBe(b.length);
    expect(rms(a, 100, a.length - 100)).toBeCloseTo(rms(b, 100, b.length - 100), 2);
  });
});

describe('the .wav files', () => {
  it('dithers with one LSB of triangular noise, the same every time', () => {
    const x = sine(44100, 220, 0.05, 0.3), plain = i16(wavEncode([x], 44100, 16)), d1 = i16(wavEncode([x], 44100, 16, true)), d2 = i16(wavEncode([x], 44100, 16, true));
    expect(d1).toEqual(d2);
    let moved = 0, worst = 0;
    for (let i = 0; i < plain.length; i++) { const e = Math.abs(d1[i] - plain[i]); worst = Math.max(worst, e); if (e) moved++; }
    expect(worst).toBeLessThanOrEqual(1);
    expect(moved).toBeGreaterThan(plain.length / 4);
    // The header is the plain file's, and a file without dither is what it always was.
    expect(wavEncode([x], 44100, 16, true).subarray(0, 44)).toEqual(wavEncode([x], 44100, 16).subarray(0, 44));
    expect(wavEncode([x], 44100, 16, false)).toEqual(wavEncode([x], 44100, 16));
  });

  it('writes at the rate asked for, or the audio\'s own', () => {
    const x = sine(48000, 440, 0.1);
    const own = wavFile([x], 48000, { bits: 24, rate: null, dither: false });
    expect(own).toEqual(wavEncode([x], 48000, 24));
    const at = wavFile([x], 48000, { bits: 16, rate: 44100, dither: false }), v = new DataView(at.buffer);
    expect(v.getUint32(24, true)).toBe(44100);
    expect(v.getUint16(34, true)).toBe(16);
    expect(v.getUint32(40, true)).toBe(Math.round(x.length * 44100 / 48000) * 2);
  });
});
