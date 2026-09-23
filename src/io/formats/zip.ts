// ZIP with every entry stored (no compression): audio doesn't shrink much, and it keeps this small.

let crcT: Uint32Array | null = null;
export function crc32(u8: Uint8Array): number {
  if (!crcT) {
    crcT = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  }
  let c = 0xffffffff;
  for (let i = 0; i < u8.length; i++) c = crcT[(c ^ u8[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

export function zipFiles(files: readonly ZipEntry[], d: Date = new Date()): Uint8Array {
  const enc = new TextEncoder();
  const dt = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const tm = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const F = files.map((f) => ({ nm: enc.encode(f.name), data: f.data, crc: crc32(f.data), off: 0 }));
  let size = 22;
  for (const f of F) size += 30 + 46 + 2 * f.nm.length + f.data.length;
  const out = new Uint8Array(size), v = new DataView(out.buffer);
  let p = 0;
  for (const f of F) {
    f.off = p;
    v.setUint32(p, 0x04034b50, true); v.setUint16(p + 4, 20, true); v.setUint16(p + 6, 0x0800, true); v.setUint16(p + 8, 0, true);
    v.setUint16(p + 10, tm, true); v.setUint16(p + 12, dt, true);
    v.setUint32(p + 14, f.crc, true); v.setUint32(p + 18, f.data.length, true); v.setUint32(p + 22, f.data.length, true);
    v.setUint16(p + 26, f.nm.length, true); v.setUint16(p + 28, 0, true);
    out.set(f.nm, p + 30); out.set(f.data, p + 30 + f.nm.length);
    p += 30 + f.nm.length + f.data.length;
  }
  const cd = p;
  for (const f of F) {
    v.setUint32(p, 0x02014b50, true); v.setUint16(p + 4, 20, true); v.setUint16(p + 6, 20, true); v.setUint16(p + 8, 0x0800, true);
    v.setUint16(p + 10, 0, true); v.setUint16(p + 12, tm, true); v.setUint16(p + 14, dt, true);
    v.setUint32(p + 16, f.crc, true); v.setUint32(p + 20, f.data.length, true); v.setUint32(p + 24, f.data.length, true);
    v.setUint16(p + 28, f.nm.length, true);
    v.setUint32(p + 42, f.off, true); out.set(f.nm, p + 46);
    p += 46 + f.nm.length;
  }
  v.setUint32(p, 0x06054b50, true); v.setUint16(p + 8, F.length, true); v.setUint16(p + 10, F.length, true);
  v.setUint32(p + 12, p - cd, true); v.setUint32(p + 16, cd, true);
  return out;
}
