# Transients: finding onsets in held and pitched music

Step 1 marks the transients: candidates are picked from an onset detection function
(`core/dsp/onset.ts`), placed on the waveform at sample level (`core/dsp/refine.ts`), and the
sensitivity and gap choose among them (`core/markers/detect.ts`). Four of the detection functions
came from the original single-file app and are tuned for drums. The fifth, **SuperFlux**
(`core/dsp/superflux.ts`), is for material that holds its notes: piano, keys, organ, pads, strings,
guitar left to ring. This page is why it exists, what it does, and how it scores.

## Why spectral flux fires on a held piano note

Spectral flux adds up, over every frequency bin, how much the log magnitude rose since the frame
6 ms before. A drum hit rises in hundreds of bins at once and nothing else comes close. A held piano
note is two or three strings a cent or so apart, so each of its partials swells and dips a few times
a second as the strings drift in and out of phase, and each partial beats at its own rate. On a chord
there are dozens of partials, and their small rises add up to peaks as tall as a soft note.

The picking made it worse. Candidates are scored against the 98th percentile of the take's own
peaks, so a take with few real onsets (a sparse piano part) sets its scale from its wobbles, and the
starting sensitivity lets through anything over 9% of that. On a synthetic piano chord held for five
seconds with three detuned strings a note (`synthStrings` in `core/notes/synth.ts`), flux at the
starting settings put down 49 markers for 2 onsets. Complex domain (48), energy (47) and group
delay (31) did no better: complex domain expects each bin's phase to turn steadily, which two
detuned strings in one bin don't do, and it weighs a quiet noisy bin as much as a loud one.

## What SuperFlux does

Three things, each from the literature on onsets in pitched, non-percussive music, and a fourth that
was tried and left out:

1. **SuperFlux** (Böck & Widmer, DAFx 2013 [1]). The spectrum is read in a window twice as long
   (46 ms at 44.1 kHz), in bands a quarter tone wide, and each band is compared with the loudest of
   it and its neighbours 15 ms before, not the frame just before. A partial that wobbles in level or
   pitch is never much louder than its own recent past; a new note is.
2. **Peaks against the mean around them, on a fixed scale** (Böck, Krebs & Schedl, ISMIR 2012 [3]).
   A candidate is the highest point within 30 ms either side and is measured by how far it stands
   over the mean from 100 ms before to 70 ms after. The levels are compressed against the loudest
   sample of the take, so that measure means the same from one take to the next, and it is not
   scaled against the take's loudest peaks.
3. **Asking what lasts**, the lesson of the transcription models (Onsets and Frames, Hawthorne et
   al., ISMIR 2018 [4]; the attack/decay model of Cheng et al., ISMIR 2016 [5]): a note detector
   believes an onset only when the note is still there once it has passed. For each candidate, the
   spectrum in a window wholly after it is compared band by band with the loudest of each band and
   its neighbours in a window wholly before it, and the rises are added up (`lasting`). A new note
   or hit leaves more behind than was there; a string's swell, a damper's thump or a note letting go
   does not.
4. **Local group delay weighting** (Böck & Widmer, ISMIR 2013 [2]) was built and scored, and is not
   in the code. The phase slope across a band says where in the window its energy sits, and each
   band's rise was weighted by how late it sat. On BabySlakh it moved the markers and every chord
   class by under a point either way: the maximum filter and the fixed scale already take out what
   it would.

A candidate's strength, which the sensitivity reads, is the geometric mean of the two measures,
what lasts (against 60) to the power 0.4 and the peak over its mean (against 12) to the power 0.6,
taken as 1 − e^−v so it nears 1 without reaching it: the lowest sensitivities still thin out the
loud hits. The scales and the weights were chosen on the odd-numbered songs of BabySlakh, as the
best mean over sensitivities 40, 55 and 70. The peak alone scored within half a point of the blend
at 55 and a little under it either side; what lasts alone, five points under.

**Not built:** a pitch detector as a third opinion (Collins, ISMIR 2005 [8]; Holzapfel et al.,
IEEE TASLP 2010 [9], who gained 8% F by fusing phase, magnitude and pitch on monophonic
recordings). The markers are asked of any material, mixes included, where one pitch track says
little; what lasts, per quarter-tone band, asks the same question of every pitch at once.

## How it scores

`bench/onsets.eval.ts` scores the markers on BabySlakh [6], the 20 songs whose stems the notes
benchmark uses: every stem (drums too) and every song's mix, against the onsets of the MIDI each was
rendered from. A marker counts within 50 ms of an onset, each onset once, and notes starting within
30 ms of each other are one onset. The constants were chosen on the odd-numbered songs and checked
on the even-numbered ones.

```bash
bash scripts/fetch_slakh.sh      # once, 900 MB into .dev/
npx vitest run --config bench/vitest.config.ts bench/onsets.eval.ts     # .dev/eval/onsets-current.md
```

On the even-numbered songs, the half the constants were not chosen on, F-measure at sensitivities
40, 55 (the starting one) and 70, and the false markers at 55:

| class | flux | SuperFlux | false markers at 55 |
| --- | --- | --- | --- |
| piano | 78.1 / 51.0 / 36.4 | 93.5 / **94.5** / 79.4 | 7849 → 188 |
| guitar | 82.5 / 69.5 / 57.4 | 88.0 / **85.9** / 73.2 | 4273 → 1251 |
| bass | 76.1 / 48.0 / 31.5 | 94.6 / **91.8** / 86.8 | 7699 → 612 |
| strings | 90.7 / 86.7 / 47.0 | 95.0 / **96.7** / 64.6 | 116 → 0 |
| strings, legato | 12.2 / 12.2 / 11.9 | 32.6 / **28.6** / 13.2 | 20212 → 2045 |
| organ | 24.1 / 23.9 / 23.7 | 63.8 / **29.3** / 24.3 | 3270 → 2276 |
| brass | 34.4 / 25.0 / 21.0 | 61.9 / **57.3** / 29.4 | 3657 → 577 |
| reed | 12.7 / 6.9 / 4.9 | 36.8 / **57.1** / 21.2 | 388 → 15 |
| mallets | 99.7 / 98.5 / 86.5 | 99.4 / **99.8** / 94.8 | 15 → 0 |
| synth lead | 51.7 / 19.3 / 17.6 | 91.3 / **41.5** / 18.5 | 2512 → 847 |
| synth pad | 20.8 / 20.4 / 19.9 | 9.4 / **13.4** / 20.2 | 7433 → 632 |
| drums | 67.4 / 74.1 / 89.0 | 80.2 / **89.5** / 87.8 | 19 → 66 |
| full mix | 67.2 / 72.4 / 61.7 | 66.1 / **78.6** / 65.1 | 3610 → 929 |
| mean of the classes | 52.8 / 44.8 / 37.5 | 66.3 / **64.3** / 50.2 | |

Flux misses 3711 drum onsets at 55 where SuperFlux misses 1661: scaled against the take's loudest
peaks, flux drops the soft hits under a loud kit. Complex domain, the other function meant for
pitched notes, scored under flux on the mean of the classes (40.6 at 55). What is still
poor is what has no attack to find: a pad or a bowed legato line fades in, and an organ's notes
start at full level with nothing new in the spectrum but their pitch. SuperFlux is the starting
detection function; the others stay in the menu, and a session keeps the one it was saved with.

Where the markers land is as good as flux's: both are placed on the waveform by the same
`refineOnset`, and on the synthetic parts, whose attacks are known to the sample, the median error
is 0.0 ms for both. Against the MIDI of the plucked and struck stems, SuperFlux's markers were as
close as flux's or a few milliseconds closer; bowed and blown notes land later, where their slow
attack has become audible.

## What the note detectors took from it

The chord detector already found its onsets with SuperFlux, on its own FFT bins. That code is now
the shared `onsetsOf`, which reads them the same way in half the time. The rest was scored on the
chord classes (`bench/tune.eval.ts`, odd-numbered songs) and none of it helped: quarter-tone bands
and the group delay moved each class by under a point either way, and keeping only the onsets that
leave something lasting behind gained at most a tenth of a point and, made stricter, lost up to nine
(mallets).
The chord tracker already asks every pitch whether its activation is still up once the onset has
left the window, which is the same question asked per pitch instead of per onset.

One line (bass) finds a note plucked again on the same pitch from the loudness envelope. SuperFlux
onsets were tried there as a second opinion, both to add re-plucks the envelope missed and to veto
the ones no onset backed; on the bass stems neither changed a single note. Each note there comes out
of the pitch track as a stretch of its own, and the envelope has nothing left to split.

## References

1. S. Böck, G. Widmer. "Maximum filter vibrato suppression for onset detection." DAFx-13, 2013.
2. S. Böck, G. Widmer. "Local group delay based vibrato and tremolo suppression for onset
   detection." ISMIR 2013.
3. S. Böck, F. Krebs, M. Schedl. "Evaluating the online capabilities of onset detection methods."
   ISMIR 2012.
4. C. Hawthorne et al. "Onsets and Frames: Dual-objective piano transcription." ISMIR 2018.
5. T. Cheng, M. Mauch, E. Benetos, S. Dixon. "An attack/decay model for piano transcription."
   ISMIR 2016.
6. E. Manilow et al. BabySlakh, the first 20 songs of Slakh2100 at 16 kHz. CC BY 4.0.
7. J. P. Bello, L. Daudet, S. Abdallah, C. Duxbury, M. Davies, M. Sandler. "A tutorial on onset
   detection in music signals." IEEE TSAP 13(5), 2005.
8. N. Collins. "Using a pitch detector for onset detection." ISMIR 2005.
9. A. Holzapfel, Y. Stylianou, A. C. Gedik, B. Bozkurt. "Three dimensions of pitched instrument
   onset detection." IEEE TASLP 18(6), 2010.
10. D. Stowell, M. Plumbley. "Adaptive whitening for improved real-time audio onset detection."
    ICMC 2007.
