// Shared shapes of the audio-editing core. Times are seconds from the start of the file; positions
// (q) are quarter notes from bar 1, so they stay put when the meter's beat unit changes.

/** A transient the detector found. `s` is its strength, 0..1 relative to the loudest in the file. */
export interface Candidate {
  readonly t: number;
  readonly s: number;
}

/** A marker on the waveform: either a detected candidate or one placed by hand. */
export interface Marker {
  readonly t: number;
  readonly s: number;
  readonly manual: boolean;
  /** Stable identity for selection: `c<index>` for a candidate, `m<n>` for a manual marker. */
  readonly id: string;
}

/** A pin tying musical position q to time t. Bar 1 is always the pin at q = 0. */
export interface Anchor {
  readonly q: number;
  readonly t: number;
  /** Placed or confirmed by the user, as opposed to found by auto-map. */
  readonly manual: boolean;
}

export interface TimeRange {
  readonly a: number;
  readonly b: number;
}

/** Anything with a time, sorted ascending; what lowerBound searches. */
export interface Timed {
  readonly t: number;
}
