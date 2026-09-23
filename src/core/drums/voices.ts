// The kit voices the drum detector tells apart, and what each one means to the rest of the app.

export const VOICES = ['kick', 'snare', 'hat'] as const;
export type Voice = (typeof VOICES)[number];

/** General MIDI percussion notes, as Pocket Science's groove files use them. */
export const GM_NOTE: Record<Voice, number> = { kick: 36, snare: 38, hat: 42 };

export const VOICE_LABEL: Record<Voice, string> = { kick: 'Kick', snare: 'Snare', hat: 'Hats' };

/** One hit of one voice. `s` is how clearly it stands out (0..1), `a` how loud it is. */
export interface DrumHit {
  readonly t: number;
  readonly s: number;
  readonly a: number;
}

export type PerVoice<T> = Record<Voice, T>;

export const perVoice = <T>(fn: (v: Voice) => T): PerVoice<T> => ({ kick: fn('kick'), snare: fn('snare'), hat: fn('hat') });

/** Sensitivity 0..100 to the strength a hit must reach; the same curve as the transient markers'. */
export const drumThreshold = (sens: number): number => Math.pow(1 - sens / 100, 3);
