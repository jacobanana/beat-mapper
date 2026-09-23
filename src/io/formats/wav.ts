/** PCM WAV, interleaved, 16 or 24-bit. */
export function wavEncode(chans: readonly Float32Array[], sr: number, bits: 16 | 24 = 16): Uint8Array {
  const ch = chans.length, n = chans[0].length, bps = bits === 24 ? 3 : 2, dataLen = n * ch * bps;
  const out = new Uint8Array(44 + dataLen), v = new DataView(out.buffer);
  const W = (p: number, str: string) => { for (let i = 0; i < str.length; i++) out[p + i] = str.charCodeAt(i); };
  W(0, 'RIFF'); v.setUint32(4, 36 + dataLen, true); W(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * ch * bps, true); v.setUint16(32, ch * bps, true); v.setUint16(34, bits === 24 ? 24 : 16, true);
  W(36, 'data'); v.setUint32(40, dataLen, true);
  let p = 44;
  if (bits === 24) {
    for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) {
      const q = Math.max(-8388607, Math.min(8388607, Math.round(chans[c][i] * 8388607)));
      out[p] = q & 255; out[p + 1] = (q >> 8) & 255; out[p + 2] = (q >> 16) & 255; p += 3;
    }
  } else {
    for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) {
      v.setInt16(p, Math.max(-32767, Math.min(32767, Math.round(chans[c][i] * 32767))), true); p += 2;
    }
  }
  return out;
}

/** Rough size of a WAV holding `samples` frames. */
export const wavSize = (samples: number, channels: number, bits: 16 | 24): number => samples * channels * (bits / 8) + 44;
