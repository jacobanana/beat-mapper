// A Standard MIDI File read back into notes in seconds: what the transcription benchmark scores
// against. Only what a rendered stem needs: tempo changes and note on/off; everything else is skipped.

export interface MidiNote {
  pitch: number;
  t: number;
  end: number;
  vel: number;
}

export function readMidi(bytes: Uint8Array): MidiNote[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const str = (o: number) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  if (str(0) !== 'MThd') throw new Error('not a MIDI file');
  const ntrk = dv.getUint16(10), div = dv.getUint16(12);
  if (div & 0x8000) throw new Error('SMPTE time division is not supported');
  // Every event in ticks first, since a tempo change in one track times the notes of all of them.
  const tempos: { tick: number; uspq: number }[] = [];
  const raw: { on: number; off: number; pitch: number; vel: number }[] = [];
  let o = 14;
  for (let tr = 0; tr < ntrk; tr++) {
    while (str(o) !== 'MTrk') o += 8 + dv.getUint32(o + 4);
    const end = o + 8 + dv.getUint32(o + 4);
    let p = o + 8, tick = 0, status = 0;
    const open = new Map<number, { tick: number; vel: number }[]>();
    const vlq = () => { let v = 0, b; do { b = bytes[p++]; v = (v << 7) | (b & 0x7f); } while (b & 0x80); return v; };
    while (p < end) {
      tick += vlq();
      // Running status: a data byte first means the last status byte again.
      if (bytes[p] & 0x80) status = bytes[p++];
      if (status === 0xff) {
        const type = bytes[p++], len = vlq();
        if (type === 0x51) tempos.push({ tick, uspq: (bytes[p] << 16) | (bytes[p + 1] << 8) | bytes[p + 2] });
        p += len;
      } else if (status === 0xf0 || status === 0xf7) {
        p += vlq();
      } else {
        const kind = status & 0xf0, key = (status & 0x0f) * 128 + bytes[p];
        if (kind === 0x90 || kind === 0x80) {
          const pitch = bytes[p], vel = bytes[p + 1];
          if (kind === 0x90 && vel > 0) {
            const q = open.get(key) ?? [];
            q.push({ tick, vel });
            open.set(key, q);
          } else {
            const s = open.get(key)?.shift();
            if (s) raw.push({ on: s.tick, off: tick, pitch, vel: s.vel });
          }
        }
        p += kind === 0xc0 || kind === 0xd0 ? 1 : 2;
      }
    }
    o = end;
  }
  tempos.sort((a, b) => a.tick - b.tick);
  if (!tempos.length || tempos[0].tick > 0) tempos.unshift({ tick: 0, uspq: 500000 });
  // Seconds at each tempo change, then any tick is the last change before it plus the rest at its rate.
  const at: number[] = [0];
  for (let i = 1; i < tempos.length; i++) at.push(at[i - 1] + ((tempos[i].tick - tempos[i - 1].tick) * tempos[i - 1].uspq) / 1e6 / div);
  const sec = (tick: number) => {
    let i = tempos.length - 1;
    while (i > 0 && tempos[i].tick > tick) i--;
    return at[i] + ((tick - tempos[i].tick) * tempos[i].uspq) / 1e6 / div;
  };
  return raw.map((n) => ({ pitch: n.pitch, t: sec(n.on), end: sec(n.off), vel: n.vel })).sort((a, b) => a.t - b.t || a.pitch - b.pitch);
}
