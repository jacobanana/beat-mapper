let ctx: AudioContext | null = null;

/** The page's one AudioContext, created on first use (browsers want a user gesture first). */
export function audioContext(): AudioContext {
  if (!ctx) {
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    ctx = new Ctor();
  }
  return ctx;
}

/** Decodes an encoded audio file (WAV, MP3, M4A, FLAC…). */
export function decodeAudio(data: ArrayBuffer): Promise<AudioBuffer> {
  const c = audioContext();
  return new Promise((res, rej) => {
    // Old Safari only has the callback form; everything else returns a promise too.
    const p = c.decodeAudioData(data, res, rej) as Promise<AudioBuffer> | undefined;
    if (p) p.then(res, rej);
  });
}

export function channelsOf(buf: AudioBuffer): Float32Array[] {
  const out: Float32Array[] = [];
  for (let i = 0; i < buf.numberOfChannels; i++) out.push(buf.getChannelData(i));
  return out;
}

/** An AudioBuffer holding the given channels. */
export function bufferFrom(chans: readonly Float32Array[], sr: number): AudioBuffer {
  const b = audioContext().createBuffer(chans.length, chans[0].length, sr);
  chans.forEach((c, k) => {
    if (b.copyToChannel) b.copyToChannel(c as Float32Array<ArrayBuffer>, k);
    else b.getChannelData(k).set(c);
  });
  return b;
}
