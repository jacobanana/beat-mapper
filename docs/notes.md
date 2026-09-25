# Notes: turning pitched audio into MIDI

The Groove step turns drums into MIDI. This page is the research for the step after it: pitched
notes (a bass line, a lead, a vocal, keys or guitar) as MIDI notes with pitch, start, length, velocity
and bends. It starts with what is built (step 6, `src/core/notes/`), then the research it came from:
the DSP and academic methods, which ones fit this app, and what is left to build.

Basic Pitch [1] is the obvious ready-made answer, and on real material it disappoints. So the plan is
to learn from it (see [What to take from Basic Pitch](#what-to-take-from-basic-pitch)) but build on
signal processing the app already has, the way the drum detector was built.

## What is built

Step 6, **Notes**, finds the notes in the audio as **one line** (a bass line, a lead, a voice) or as
**chords** (keys, guitar), draws them as a piano roll, plays them on a synth voice and exports them
as MIDI: one track, with lengths, velocities and pitch bends, placed where the warp puts them when it
is heard warped. The sensitivity picks among the notes, a note can be deleted, and **Legato** holds
each note until the next one starts. No trained model is involved.

**One line** (`line.ts`) is pYIN [9]: YIN candidates from one FFT per 10 ms frame, on the audio
decimated to about 11 kHz, and a Viterbi pass over pitch states 10 cents apart plus an unvoiced state.
Small moves cost little (vibrato, a bend); any other change is one fixed-price jump, so a frame an
octave off costs two jumps and loses. Its path is cut into notes: a new note where the pitch *steps*
across a semitone or where there is an attack (the same pitch plucked again), one note bent where it
*glides*, and a stretch under 60 ms belongs to its neighbour. The pitch of a note is the semitone it
spends longest on.

**Chords** (`chords.ts`) is NMF with one harmonic comb per semitone from E1 to C7, on a log-frequency
spectrogram three bins a semitone: 186 ms windows under 400 Hz, 93 ms above, every 20 ms. The combs
are zero between their partials and stay fixed. Letting them learn the instrument's partial balance
let an A2 comb drop its odd partials and become an A3, so every A3 was read as A2 plus A4. The cost
is KL (β = 1).

Which notes a chord has is decided onset by onset, all pitches together. The onsets are peaks of a
spectral flux (SuperFlux [39]: 46 ms windows every 5 ms, log-compressed, each bin against the loudest
of its neighbours 15 ms before). The waveform's envelope misses most of a piano part: a soft melody
note over a held chord barely moves the level, and on a real piano loop it found 7 of some 25 onsets.
At each onset every comb is asked how far its activation rose, from just before the window reached
the onset to the least it holds once the window has passed it and before the next onset is in it: a
strike's click lights every comb while it is in the window, and only a real note is still there after
it (the onsets gating the frames, as in [29]). The pitches that rose are taken loudest first, and one
is dropped when it rose by under 3% of the loudest, or under half of a louder one a semitone away (a
whole tone, under 400 Hz), or under 0.12 of a louder one it is a partial of (0.06 for an octave).
Tracked one pitch at a time, as they were at first, each of those was a note: a real piano loop
(Em, Fmaj7, G, Am7 over octave roots, a melody on top) came out with 141 notes where Basic Pitch
finds 54. Now it finds 54, 43 of them Basic Pitch's; the rest are mostly the same notes placed apart
(a G1 90 ms from Basic Pitch's) or ones Basic Pitch leaves out (the E1 under the E2). The
strength the sensitivity reads is a note's rise against the loud notes of the take, to the power 0.8,
so the starting sensitivity keeps notes down to about 25 dB under them and turning it down drops the
doublings and the soft melody before the roots.

**Both** time a start on the waveform. The attacks are read on the audio high-passed at 150 Hz by a
*forward-only* filter, in 2 ms blocks: a zero-phase filter rings before an attack and put starts 8 ms
early, and without the high-pass a bass note's own waveform ripples a 4 ms window like a string of
attacks. `refineOnset`, which places the
transients, is tuned to drums and moved bass notes by up to 13 ms, so notes get their own
sample-level pass. A line's note ends where its level falls 20 dB within 30 ms (the player damping
it), else where it has faded 30 dB under its peak, else where the pitch lets go. The tuning is the
circular mean of where each measured pitch sits between two semitones.

On the synthetic parts (`synth.ts`: a funk bass line tuned 20 cents flat with repeated notes, an
octave leap and a bend of a whole tone; a keyboard part in chords with doubled octaves and a melody
over a held chord; a piano voiced low, chords over octave roots from E1 with a soft melody over them):

| | bass line, one line | keys, chords | low piano, chords |
| --- | --- | --- | --- |
| notes found | 28 of 28, none extra | 28 of 28, none extra | 23 of 24, none extra (the missed D5 is found at 80) |
| start error | all under 5 ms, median under 1.5 ms | all under 5 ms, median under 1 ms | all under 6 ms, median 1 ms |
| end | within 50 ms or 20% | within 50 ms or 20%, but the G3 doubling G2 ends 0.46 s early | within 50 ms or 20% but one |
| tuning | −20.0 cents | 0.5 cents | 1.5 cents |
| time for 3 minutes | 2.7 s | 6.3 s | |

What it doesn't do yet:

- **Full mixes.** Both modes assume one instrument. On the drum demo chords mode finds hundreds of
  notes. Stem separation first, as for the drums.
- **Low notes in chords.** The 186 ms window can't tell two notes of one pitch apart when they are
  closer than it, and chords mode gets 22 of the bass line's 28 notes (none extra). Use one line for
  bass.
- **Swells.** A note needs an onset. A pad fading in with nothing new in its spectrum at any moment
  isn't found.
- **A melody note on a chord's partial.** A D5 over a held G3 is the G3's third partial too, and the
  factorisation gives the D5 comb little of it: the note is found, but quieter than it is.
- **Octave doublings.** As a chord rings, the lower note takes over the upper one's partials.
- **Bends in chords.** Only a line has bends: bends on several notes at once need MPE.

### On rendered instruments: BabySlakh

`bench/` scores both modes on BabySlakh [40]: the first 20 songs of Slakh2100 [35], every stem
rendered from MIDI with a sample-based instrument and kept beside that MIDI. Bass stems are read as
one line; piano, guitar, organ and mallet stems as chords. The scores are mir_eval's [33]: a note
matches when its pitch is right and its onset within 50 ms, and "F, ends" also needs its end within
20% of its length or 50 ms. 40 of the 115 stems sound an octave or two from their MIDI (a bass or
guitar patch played as it is written, an octave up), so each stem is scored at the whole number of
octaves it matches best at.

```bash
bash scripts/fetch_slakh.sh   # once: about 900 MB into .dev/
make eval-notes               # 15 minutes; the report, per class and per stem, lands in .dev/eval/
```

At the starting sensitivity (55), before and after the change to chords described above, which
also found line mode placing every note late:

| | stems | F before | F now | precision now | recall now | F, ends now | onset error, median |
| --- | --- | --- | --- | --- | --- | --- | --- |
| piano, chords | 32 | 41.8 | 62.9 | 61.5 | 64.3 | 19.2 | 7 ms |
| guitar, chords | 43 | 22.7 | 36.5 | 31.4 | 43.5 | 10.8 | 15 ms |
| organ, chords | 9 | 20.9 | 36.1 | 28.0 | 50.7 | 25.6 | 2 ms |
| mallets, chords | 9 | 21.2 | 35.5 | 30.9 | 41.9 | 4.3 | 7 ms |
| bass, one line | 22 | 19.7 | 75.5 | 80.0 | 71.5 | 71.9 | 12 ms |

Line mode's frames are 110 samples apart at 11025 Hz, 9.98 ms, and were counted as 10 ms: a note
was placed 0.23% late, a quarter of a second by the second minute, past the 50 ms any score allows.
The synthetic parts are 15 seconds long and never showed it. What the numbers say is left to do:

- **Chords' ends.** A chord's notes are found, but where they end is right for under a third of them
  (a line's: nearly all). Why is not measured yet.
- **Chords at a lower sensitivity.** Chords score F 51.5 at 30 against 47.0 at 55: the one starting
  sensitivity both modes share lets through more than chords want.
- **Guitar, organ and mallets** score about half what piano does, finding 1.4 to 1.8 times as many notes as
  there are. Why is not measured yet: strums spreading a chord wider than one onset and distortion's
  partials are the first two things to look at.

## What the drum detector already gives us

Most of what a note detector needs is already in `src/core`, because the drum pipeline solved the same
shape of problem: find events on a spectrogram, tell them apart, place them at sample level.

| Needed for notes | Already here |
| --- | --- |
| A log-frequency spectrogram | `drums/spectrogram.ts` (quarter-octave bands; notes need 3 bins a semitone, see below) |
| Keeping the harmonic part of a mix | median-filter HPSS in `drums/spectrogram.ts` and `warp/hpss.ts` [2] |
| Factorising a spectrogram into templates and activations | `drums/nmf.ts`: β-divergence NMF with semi-adaptive priors plus free components [3, 4] |
| Soft, pitched onsets | the complex-domain ODF in `dsp/onset.ts` [5] |
| Picking events from an activation | `pickHits` in `drums/detect.ts` |
| Sample-level timing | `dsp/refine.ts` and the zero-phase band filters in `dsp/filter.ts` |
| Instantaneous frequency from phase | the phase vocoder in `warp/pv.ts` measures each partial's frequency from two frames a hop apart |
| Grid and tempo | the tempo map and `WarpOut`, as the drum MIDI export uses them |

The split the drum detector uses also applies to notes: a coarse model on frames says *what* is
playing, and the sample-level refine says exactly *when*. A pitch needs a long window (a low E on a
bass is 41 Hz, a 24 ms period), and a long window can't time an attack, so the two jobs must be done
separately anyway.

## The problem in two halves

Transcription is usually split into multi-pitch estimation (which pitches sound in each frame) and
note tracking (turning those frames into notes with an onset and an offset) [6, 7]. Both halves are
harder with more than one note at a time, so the literature splits again:

- **Monophonic**: one note at a time. Bass lines, leads, vocals, most solo lines. Close to solved
  with DSP alone. The errors left are octave jumps, the ends of notes, and repeated notes at the
  same pitch.
- **Polyphonic**: chords. Keys, guitar, pads. Open research. DSP methods reach roughly the same
  quality as Basic Pitch, and are clearer about why they fail.

## 1. Monophonic pitch: one f0 per frame

### YIN, and pYIN on top of it

**YIN** [8] is the standard time-domain estimator. It is autocorrelation with three fixes:

1. The difference function `d(τ) = Σ (x[j] − x[j+τ])²` in place of the autocorrelation. It can be
   computed with one FFT per frame (as `r(0) + r_τ(0) − 2r(τ)`), so a frame costs O(N log N).
2. The **cumulative mean normalised difference** `d'(τ) = d(τ) / ((1/τ) Σ_{j≤τ} d(j))`. It starts at
   1 and removes the dip at τ = 0, so the lag of a period doesn't have to beat lag zero.
3. **An absolute threshold**: take the *first* dip below a threshold (about 0.1), not the deepest one.
   This is what avoids octave-down errors, because the dip at two periods is often as deep as the dip
   at one. Parabolic interpolation around the dip then gives a pitch far finer than one sample of lag.

**pYIN** [9] replaces the single threshold with a distribution over thresholds. Each frame then
yields several f0 candidates with probabilities, and an HMM (pitch bins × voiced/unvoiced, a small
pitch-change penalty) is Viterbi-decoded over the whole take. This is the biggest single fix for octave
errors: a single frame that jumps an octave costs more than it explains. It also gives a voicing
decision (note or silence) from the same pass. librosa's `pyin` is a reference implementation.

**Tony** [10] is the same group's note-level layer on top of pYIN. Each semitone gets a small HMM of
attack, stable and silent states, and the decoded path is a list of notes. Their evaluation on
singing is the best published evidence that DSP note tracking works on real monophonic material.

### Alternatives worth knowing

- **McLeod Pitch Method (MPM)** [11]: the normalised square difference function, a close cousin of
  YIN that picks the first key maximum over a fraction of the highest one. Popular in tuners because
  it is fast and stable with short windows.
- **SWIPE′** [12]: matches the spectrum against a sawtooth-like kernel with decaying harmonic weights,
  using only the first and prime harmonics. Very robust for speech and voice, heavier to compute.
- **Subharmonic summation** [13]: add the spectrum compressed by 1, 2, 3… onto a log-frequency axis.
  The peak is the pitch. It is the idea behind every harmonic-summation salience below.
- **Small neural models**, if we ever want one: CREPE [14] (the best known; the tiny model is
  small enough for the browser), PESTO [15] (under 30k parameters, self-supervised on
  pitch-shifted CQT, ISMIR 2023 best paper) and SwiftF0 [16] (96k parameters, 2025, reported
  much more robust to noise than CREPE and about 40× faster). All three are monophonic f0 only. They
  would replace step 1 below, nothing else.

### What matters for a bass line in particular

- **Window length**: YIN needs about two periods, so an E1 (41 Hz) needs a window of 50 ms or more
  (2048 samples at 44.1 kHz; 4096 for a five-string's low B at 31 Hz). Lead lines can use 1024.
- **Downsample first**: a bass's f0 range fits comfortably under 2 kHz. Resampling to 11 kHz
  (`dsp/resample.ts`) cuts the cost by 4 and removes hats and cymbals that would otherwise bleed in.
- **The missing fundamental**: on small speakers and in dense mixes the bass's fundamental is often
  weaker than its second harmonic. Time-domain methods (YIN, MPM) handle this naturally because they
  look for the period, not the strongest partial. Spectral peak-picking doesn't.
- Bass-specific transcription papers (Ryynänen & Klapuri [17], Abeßer & Schuller [18]) add a
  musicological model: note-to-note transitions weighted by the key. Useful later; not needed first.

## 2. Polyphonic pitch: which notes sound in each frame

### A pitch axis fine enough

The drum spectrogram's quarter-octave bands are far too coarse. Notes need **3 bins per semitone**
(36 per octave): one for the note and one either side, so a note that is a little sharp or bending
still lands on its own bin, and the tuning can be measured. That is Basic Pitch's choice too [19].

Summing FFT bins into log bands doesn't work in the bass: with a 4096 FFT at 44.1 kHz the bins are
10.8 Hz apart, while a semitone at A1 (55 Hz) is 3.3 Hz. The options:

- **Constant-Q transform** [20]: each bin's window is as long as its frequency needs. The efficient
  version computes it from FFTs over octaves, downsampling by 2 between them.
- **Multi-resolution FFT**: a long FFT for the low octaves and a short one above, stitched together.
  Simpler, and close enough.
- **Spectral peaks with instantaneous frequency**: pick each FFT frame's peaks and measure their true
  frequency from the phase advance over one hop, as `warp/pv.ts` already does. A peak's frequency is
  then far finer than the bin spacing, which suits sparse material (a clean guitar, a piano).

### Salience: how likely each pitch is to be sounding

- **Harmonic summation (Klapuri 2006)** [21]. After *spectral whitening* (flattening the spectral
  envelope so a bright and a dark instrument read the same), the salience of a candidate f0 is a
  weighted sum of the amplitudes at its harmonics, `s(f0) = Σ_h g(f0, h) · max |X(k)|` over the bins near
  `h·f0`, with weights that fall with harmonic number. Then **estimate and cancel**: take the most
  salient f0, subtract its harmonics from the spectrum, recompute, and stop when adding another note
  explains too little. The spectral smoothness rule in the cancellation (Klapuri 2003 [22]) is what
  stops a note's second and third harmonics from being reported as notes of their own.
- **Harmonic CQT stacking (Bittner et al. 2017)** [23]. Shift the CQT by the log of each harmonic
  (½, 1, 2, 3, 4, 5) and stack the copies, so the harmonics of any note line up at one bin. Basic Pitch
  and its predecessor feed this to a CNN. Without a network, a weighted geometric mean across the
  stack is already a salience function that punishes octave errors (an octave-up candidate is missing
  the odd harmonics). It is cheap: shifts of one array.
- **Peaks and non-peaks (Duan, Pardo & Zhang 2010)** [24]. A maximum-likelihood method that scores a
  set of f0s both on the peaks it explains and on the silence where it predicts no peak. The second
  part is what suppresses octave and fifth ghosts.

### NMF with harmonic templates: the drum detector, extended

This is the most natural path for this codebase. Smaragdis & Brown [25] showed that NMF on a
spectrogram learns one template per note and one activation per note, exactly as `nmf.ts` does for
kick, snare and hats. The literature since then adds the constraints that make it reliable, and each
of them has an equivalent in the drum detector:

- **Harmonic priors, semi-adaptive** (Vincent, Bertin & Badeau 2010 [26]): one template per semitone
  in the instrument's range, built as a comb of harmonics with a smooth, decaying envelope. It is
  allowed to adapt to the instrument's timbre but not to become another pitch. That is what the drum
  priors already do, with their pull fading out gradually and each template kept to its own frequency
  range.
- **Free components** absorb drums and everything that isn't a note, as they do the pitched parts of a
  mix in the drum detector (Wu & Lerch [4]). Starting from the harmonic part of the HPSS makes it
  easier.
- **Shift invariance** (Benetos & Dixon, PLCA [27]): one template per instrument, shifted along the
  log-frequency axis to every pitch. Fewer parameters to learn, and a sharp or bending note is still
  explained. More work to implement than a comb per semitone.
- **An attack and a decay per note** (Cheng, Mauch, Benetos & Dixon 2016 [28]): each note gets an
  attack template and a decay template, with the decay's activation following an exponential. This is
  the NMF answer to where a piano or guitar note *ends*, which a plain activation blurs into its
  reverb.
- **The divergence is an open question here.** The drum detector found squared error (β = 2) better
  than KL, because KL let one voice explain another's attack. The pitched NMF literature mostly uses
  KL or β = 0.5, which are kinder to quiet upper harmonics. Measure it on synthetic material before
  choosing, as was done for the drums.

The appeal is that the whole pipeline after the factorisation is the one already written for drums:
activations rise at onsets, `pickHits` finds the rises, bleed between neighbouring templates can be
measured and subtracted like the leaks between drums, and `refine.ts` places each attack.

## 3. From frames to notes

A pitch contour or a set of activations is not yet a list of notes. This half is where transcribers
most often go wrong in practice, and where Basic Pitch's output looks most wrong to the ear.

- **Onsets gate notes.** Onsets and Frames (Hawthorne et al. 2018) [29] showed that a note should start
  only where an onset is detected, and the frame activation only extends it. It was the biggest
  single improvement in piano transcription at the time. Here the onset comes from the note's
  activation rise *and* the complex-domain ODF in its band: two measures that have to agree.
- **Repeated notes at the same pitch** can't be split by pitch. A mono tracker has to use the onset
  function (and the dip in energy between them) to split the pitch contour.
- **Hysteresis and a minimum length.** A note starts above one threshold and ends below a lower one,
  and notes shorter than about 50–80 ms are dropped or merged. Per-pitch two-state HMMs
  (Poliner & Ellis [30]) do the same thing with probabilities.
- **Octave and harmonic ghosts.** A note 12 or 19 semitones above another, starting within a frame of
  it and much weaker than the lower note's own harmonic would be, is that harmonic. Drop it.
- **Sub-frame onset and offset times.** High-resolution piano transcription (Kong et al. 2021) [31]
  regresses each onset's distance from the frame centre rather than rounding to the frame. The
  refine pass here does the same job at sample level, and doesn't need training.
- **Tuning.** Estimate the recording's offset from A440 once, as the circular mean of every peak's
  deviation from the nearest semitone, and shift the pitch axis. Otherwise a band tuned 30 cents flat
  splits every note between two bins.
- **Velocity** from the peak of the note's activation, against the loud notes of the same take, the
  way the drum velocities are made.
- **Pitch bend**: for monophonic lines, the f0 contour relative to the note's centre becomes MIDI
  pitch-bend events (±2 semitones is the MIDI default). A slide or a vibrato stays one note.
- **The grid.** Positions come from the tempo map, and a warped take is written against `WarpOut`'s
  straight grid, as the drum MIDI is.

## What to take from Basic Pitch

Basic Pitch [1, 19] is a small CNN (under 17k parameters) with three outputs per frame: onsets, note
activations, and a fine pitch axis for bends. Some of what it gets wrong on the material here is
predictable:

- It is instrument-agnostic and trained on isolated instruments. Its own README says it works best on
  one instrument at a time [32], and a full mix confuses its note outputs with drums, reverb and every
  other part.
- Its note creation is fixed thresholds on the onset and frame outputs, with a minimum note length.
  On unfamiliar audio the network's outputs are poorly calibrated, so the same thresholds give ghost
  notes on some takes and missed notes on others. There is no tuning estimate and no key or voice
  model.
- Its frames are 11.6 ms, so its onsets are only as good as ±6 ms, before any error in the network.

Worth taking:

- **The input representation**: 3 bins per semitone, harmonically stacked (HCQT) [23]. It works as a
  DSP salience on its own (above).
- **Separate onset and frame outputs**, onsets gating notes.
- **Its note-creation trick**: start from the strongest frame peak, extend forward and backward while
  the activation stays above a lower threshold, then mark those frames used and repeat. It is a
  simple, good greedy decoder for any salience or activation matrix.
- **Pitch bends from the fine pitch axis** rather than from a separate f0 tracker.
- **Its lesson on scope**: transcribe one stem at a time. Here that means asking the user what the
  part is (bass, lead, keys) and choosing the range and the mono or poly path from that, and later
  separating stems first, as planned for full-mix drums in [groove.md](groove.md).

## The order it was planned in

Steps 1, 3 and 4 are built (see [What is built](#what-is-built)); step 2 is the synthetic half of it.


1. **Monophonic line (bass first).** pYIN on the harmonic part, downsampled to 11 kHz: YIN candidates
   per frame, Viterbi over pitch × voicing, notes split at pitch changes and at onsets from the
   complex-domain ODF, placed by `refine.ts`, with velocity and pitch bends. The bass is the part
   `groove.md` already names as the most useful next voice: its pocket against the kick is the
   question the Groove step asks. It is also the case where DSP is most reliable.
2. **Evaluation before tuning.** A synthetic set with exact ground truth, like `synthKit` for drums:
   a plucked bass, a sine and saw lead with vibrato and slides, a piano-like additive tone with
   inharmonic partials, each rendered from known MIDI, alone and under the drum kit. Score with the
   standard note metrics (onset within 50 ms, pitch within 50 cents, offset within 20% of the note or
   50 ms; `mir_eval` [33]) and, as for drums, the timing error of the matched onsets in milliseconds.
3. **Polyphonic keys and guitar.** Harmonic-comb NMF on a 36-bins-per-octave spectrogram, reusing
   `nmf.ts` with harmonic priors, HCQT salience to seed the activations, onset gating, the greedy
   note decoder, ghost-harmonic removal. Then the attack/decay model if note ends matter.
4. **MIDI out.** `io/formats/midi.ts` writes `DrumNote`s on channel 10. Pitched notes need their own
   track and channel, lengths, and pitch-bend events.
5. **Full mixes.** Stem separation in the browser first, the same step the full-mix drums are waiting
   on; then everything above on the stem.

Where it lives: a `core/notes/` module, pure and DOM-free like `core/drums/`, run in the analysis
worker. A new step or panel, its settings and what the session saves are decisions for when step 1 is
built, and will be asked about then.

## Test material with ground truth

- **MDB-stem-synth** [34]: 230 stems from MedleyDB, resynthesised so their f0 is known exactly. The
  best check on monophonic f0.
- **Slakh2100** [35]: 2,100 songs rendered from MIDI with sample-based instruments, as separate stems.
  Its bass stems are the ideal test for step 1, and its full mixes for step 5.
- **GuitarSet** [36] (guitar, with string-level notes), **MAESTRO** [37] (piano, 200 hours aligned
  to about 3 ms) and **Bach10** [38] (four instruments, note-level) for the polyphonic path.

## References

1. Spotify Engineering. "Meet Basic Pitch: Spotify's open source audio-to-MIDI converter." 2022.
   <https://engineering.atspotify.com/2022/6/meet-basic-pitch>
2. D. FitzGerald. "Harmonic/percussive separation using median filtering." DAFx-10, 2010.
   <https://arrow.tudublin.ie/argcon/67/>
3. C. Févotte, J. Idier. "Algorithms for nonnegative matrix factorization with the β-divergence."
   Neural Computation 23(9), 2011. <https://hal.sorbonne-universite.fr/ENST/hal-00626110v1>
4. C.-W. Wu, A. Lerch. "Drum transcription using partially fixed non-negative matrix factorization
   with template adaptation." ISMIR 2015. <https://zenodo.org/records/1417839>
5. S. Dixon. "Onset detection revisited." DAFx-06, 2006.
6. E. Benetos, S. Dixon, Z. Duan, S. Ewert. "Automatic Music Transcription: An Overview." IEEE Signal
   Processing Magazine 36(1), 2019. <https://doi.org/10.1109/MSP.2018.2869928>
7. A. Klapuri, M. Davy (eds.). *Signal Processing Methods for Music Transcription.* Springer, 2006.
8. A. de Cheveigné, H. Kawahara. "YIN, a fundamental frequency estimator for speech and music." JASA
   111(4), 2002, pp. 1917–1930. <https://doi.org/10.1121/1.1458024>
9. M. Mauch, S. Dixon. "pYIN: A fundamental frequency estimator using probabilistic threshold
   distributions." ICASSP 2014, pp. 659–663.
   <https://webspace.eecs.qmul.ac.uk/s.e.dixon/pub/2014/MauchDixon-PYIN-ICASSP2014.pdf>
10. M. Mauch, C. Cannam, R. Bittner, G. Fazekas, J. Salamon, J. Dai, J. P. Bello, S. Dixon.
    "Computer-aided melody note transcription using the Tony software: accuracy and efficiency."
    TENOR 2015. <https://code.soundsoftware.ac.uk/projects/tony>
11. P. McLeod, G. Wyvill. "A smarter way to find pitch." ICMC 2005.
12. A. Camacho, J. G. Harris. "A sawtooth waveform inspired pitch estimator for speech and music."
    JASA 124(3), 2008, pp. 1638–1652. <https://doi.org/10.1121/1.2951592>
13. D. J. Hermes. "Measurement of pitch by subharmonic summation." JASA 83(1), 1988, pp. 257–264.
14. J. W. Kim, J. Salamon, P. Li, J. P. Bello. "CREPE: A convolutional representation for pitch
    estimation." ICASSP 2018. <https://arxiv.org/abs/1802.06182>
15. A. Riou, S. Lattner, G. Hadjeres, G. Peeters. "PESTO: Pitch estimation with self-supervised
    transposition-equivariant objective." ISMIR 2023. <https://arxiv.org/abs/2309.02265> · real-time
    version, TISMIR 2025: <https://arxiv.org/abs/2508.01488>
16. L. Nieradzik. "SwiftF0: Fast and accurate monophonic pitch detection." 2025.
    <https://arxiv.org/abs/2508.18440>
17. M. Ryynänen, A. Klapuri. "Automatic transcription of melody, bass line, and chords in polyphonic
    music." Computer Music Journal 32(3), 2008.
18. J. Abeßer, G. Schuller. "Instrument-centered music transcription of solo bass guitar
    recordings." IEEE/ACM TASLP 25(9), 2017.
19. R. M. Bittner, J. J. Bosch, D. Rubinstein, G. Meseguer-Brocal, S. Ewert. "A lightweight
    instrument-agnostic model for polyphonic note transcription and multipitch estimation." ICASSP
    2022. <https://arxiv.org/abs/2203.09893>
20. C. Schörkhuber, A. Klapuri. "Constant-Q transform toolbox for music processing." SMC 2010.
21. A. Klapuri. "Multiple fundamental frequency estimation by summing harmonic amplitudes." ISMIR
    2006, pp. 216–221.
22. A. Klapuri. "Multiple fundamental frequency estimation based on harmonicity and spectral
    smoothness." IEEE Trans. Speech and Audio Processing 11(6), 2003.
23. R. M. Bittner, B. McFee, J. Salamon, P. Li, J. P. Bello. "Deep salience representations for f0
    estimation in polyphonic music." ISMIR 2017, pp. 63–70.
    <https://archives.ismir.net/ismir2017/paper/000085.pdf> · code:
    <https://github.com/rabitt/ismir2017-deepsalience>
24. Z. Duan, B. Pardo, C. Zhang. "Multiple fundamental frequency estimation by modeling spectral peaks
    and non-peak regions." IEEE TASLP 18(8), 2010.
    <https://labsites.rochester.edu/air/publications/DuanPardoZhang_MF0E_TASLP10.pdf>
25. P. Smaragdis, J. C. Brown. "Non-negative matrix factorization for polyphonic music
    transcription." WASPAA 2003.
26. E. Vincent, N. Bertin, R. Badeau. "Adaptive harmonic spectral decomposition for multiple pitch
    estimation." IEEE TASLP 18(3), 2010.
27. E. Benetos, S. Dixon. "A shift-invariant latent variable model for automatic music
    transcription." Computer Music Journal 36(4), 2012.
28. T. Cheng, M. Mauch, E. Benetos, S. Dixon. "An attack/decay model for piano transcription." ISMIR
    2016, pp. 584–590. <https://archives.ismir.net/ismir2016/paper/000085.pdf>
29. C. Hawthorne, E. Elsen, J. Song, A. Roberts, I. Simon, C. Raffel, J. Engel, S. Oore, D. Eck.
    "Onsets and Frames: Dual-objective piano transcription." ISMIR 2018.
    <https://arxiv.org/abs/1710.11153>
30. G. E. Poliner, D. P. W. Ellis. "A discriminative model for polyphonic piano transcription."
    EURASIP Journal on Advances in Signal Processing, 2007.
31. Q. Kong, B. Li, X. Song, Y. Wan, Y. Wang. "High-resolution piano transcription with pedals by
    regressing onset and offset times." IEEE/ACM TASLP 29, 2021. <https://arxiv.org/abs/2010.01815>
32. Basic Pitch (Python), README: <https://github.com/spotify/basic-pitch>
33. C. Raffel et al. "mir_eval: A transparent implementation of common MIR metrics." ISMIR 2014.
    <https://github.com/craffel/mir_eval>
34. J. Salamon, R. M. Bittner, J. Bonada, J. J. Bosch, E. Gómez, J. P. Bello. "An analysis/synthesis
    framework for automatic f0 annotation of multitrack datasets." ISMIR 2017.
35. E. Manilow, G. Wichern, P. Seetharaman, J. Le Roux. "Cutting music source separation some Slakh:
    A dataset to study the impact of training data quality and quantity." WASPAA 2019.
    <https://arxiv.org/abs/1909.08494>
36. Q. Xi, R. M. Bittner, J. Pauwels, X. Ye, J. P. Bello. "GuitarSet: A dataset for guitar
    transcription." ISMIR 2018.
37. C. Hawthorne et al. "Enabling factorized piano music modeling and generation with the MAESTRO
    dataset." ICLR 2019. <https://arxiv.org/abs/1810.12247>
38. Z. Duan, B. Pardo. "Soundprism: An online system for score-informed source separation of music
    audio." IEEE J. Selected Topics in Signal Processing 5(6), 2011 (the Bach10 dataset).
39. S. Böck, G. Widmer. "Maximum filter vibrato suppression for onset detection." DAFx-13, 2013.
40. E. Manilow et al. BabySlakh, the first 20 songs of Slakh2100 at 16 kHz. CC BY 4.0.
    <https://zenodo.org/records/4603870>
