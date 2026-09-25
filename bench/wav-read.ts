// A WAV file read to one mono channel, for the benchmark: 16/24/32-bit PCM or 32-bit float.
export function readWav(b: Uint8Array): { x: Float32Array; sr: number } {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const id = (o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  let o = 12, ch = 1, sr = 44100, bits = 16, fmt = 1;
  while (o + 8 <= b.length) {
    const n = dv.getUint32(o + 4, true);
    if (id(o) === 'fmt ') {
      fmt = dv.getUint16(o + 8, true);
      ch = dv.getUint16(o + 10, true);
      sr = dv.getUint32(o + 12, true);
      bits = dv.getUint16(o + 22, true);
      // WAVE_FORMAT_EXTENSIBLE: the real format is the sub-format's first two bytes.
      if (fmt === 0xfffe) fmt = dv.getUint16(o + 32, true);
    }
    if (id(o) === 'data') {
      const bps = bits / 8, N = Math.floor(Math.min(n, b.length - o - 8) / (bps * ch)), x = new Float32Array(N);
      const read = (q: number) =>
        fmt === 3 ? dv.getFloat32(q, true)
        : bits === 16 ? dv.getInt16(q, true) / 32768
        : bits === 24 ? (b[q] | (b[q + 1] << 8) | (dv.getInt8(q + 2) << 16)) / 8388608
        : dv.getInt32(q, true) / 2147483648;
      for (let i = 0; i < N; i++) {
        let s = 0;
        for (let c = 0; c < ch; c++) s += read(o + 8 + (i * ch + c) * bps);
        x[i] = s / ch;
      }
      return { x, sr };
    }
    o += 8 + n + (n & 1);
  }
  throw new Error('no data chunk');
}
