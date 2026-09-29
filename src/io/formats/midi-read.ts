// Reading a Standard MIDI File for its tempo map: the tempo changes and time signatures, nothing
// else. Notes, controllers and SysEx are stepped over.
import type { MidiTempo } from '../../core/tempo/import';

export class MidiReadError extends Error {}

type Tempos = { q: number; bpm: number }[];
type Sigs = { q: number; num: number; den: number }[];

/**
 * The tempo changes and time signatures of a MIDI file, at their positions in quarter notes from its
 * start. Every track is read, since a type-1 file should keep them on the first but not every program
 * does; a type-2 file's tracks are separate songs, so only the first is. Throws `MidiReadError` on
 * anything that isn't a MIDI file with a tempo map BeatMapper can place.
 */
export function readMidiTempo(bytes: Uint8Array): MidiTempo {
  const r = new Reader(bytes);
  if (r.str(4) !== 'MThd') throw new MidiReadError('That is not a MIDI file.');
  const hlen = r.u32(), format = r.u16(), ntrks = r.u16(), division = r.u16();
  r.skip(hlen - 6);
  // SMPTE timing counts frames, not beats: there is no tempo to read from it.
  if (division & 0x8000) throw new MidiReadError('That MIDI file is timed in SMPTE frames and has no tempo map.');
  const ppq = division;
  if (!ppq) throw new MidiReadError('That MIDI file has no ticks per quarter note.');
  const tempos: Tempos = [], sigs: Sigs = [];
  for (let n = 0; n < ntrks && r.left >= 8; n++) {
    const id = r.str(4), len = r.u32();
    // Chunks other than tracks are allowed and skipped; they don't count as tracks.
    if (id !== 'MTrk') { r.skip(len); n--; continue; }
    const end = Math.min(bytes.length, r.pos + len);
    // A track cut short keeps what was read of it: the tempo map is usually all at its start.
    if (format !== 2 || n === 0) {
      try { readTrack(new Reader(bytes.subarray(r.pos, end)), ppq, tempos, sigs); } catch (e) { if (!(e instanceof MidiReadError)) throw e; }
    }
    r.pos = end;
  }
  const byQ = (a: { q: number }, b: { q: number }) => a.q - b.q;
  return { tempos: tempos.sort(byQ), sigs: sigs.sort(byQ) };
}

function readTrack(r: Reader, ppq: number, tempos: Tempos, sigs: Sigs): void {
  let tick = 0, status = 0;
  while (r.left > 0) {
    tick += r.vlq();
    let b = r.u8();
    if (b === 0xff) {
      const type = r.u8(), len = r.vlq(), at = r.pos;
      if (type === 0x2f) return;
      if (type === 0x51 && len >= 3) {
        const us = (r.u8() << 16) | (r.u8() << 8) | r.u8();
        if (us > 0) tempos.push({ q: tick / ppq, bpm: 6e7 / us });
      } else if (type === 0x58 && len >= 2) {
        const num = r.u8(), dd = r.u8();
        if (num > 0 && dd < 8) sigs.push({ q: tick / ppq, num, den: 2 ** dd });
      }
      r.pos = at + len;
      continue;
    }
    if (b === 0xf0 || b === 0xf7) { r.skip(r.vlq()); status = 0; continue; }
    // A data byte first: running status, the last status byte applies again.
    if (b < 0x80) {
      if (!status) throw new MidiReadError('That MIDI file is damaged.');
      r.pos--;
      b = status;
    } else status = b;
    const kind = b & 0xf0;
    r.skip(kind === 0xc0 || kind === 0xd0 ? 1 : 2);
  }
}

class Reader {
  pos = 0;
  constructor(private readonly b: Uint8Array) {}
  get left(): number { return this.b.length - this.pos; }
  u8(): number {
    if (this.pos >= this.b.length) throw new MidiReadError('That MIDI file ends too soon.');
    return this.b[this.pos++];
  }
  u16(): number { return (this.u8() << 8) | this.u8(); }
  u32(): number { return ((this.u16() << 16) >>> 0) + this.u16(); }
  str(n: number): string { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(this.u8()); return s; }
  skip(n: number): void {
    if (n < 0 || this.pos + n > this.b.length) throw new MidiReadError('That MIDI file ends too soon.');
    this.pos += n;
  }
  vlq(): number {
    let v = 0;
    for (let i = 0; i < 4; i++) {
      const c = this.u8();
      v = (v << 7) | (c & 127);
      if (!(c & 128)) return v;
    }
    throw new MidiReadError('That MIDI file is damaged.');
  }
}
