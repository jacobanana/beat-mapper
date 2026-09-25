---
name: notes-benchmark
description: Score the note detector (audio to MIDI, one line and chords) on BabySlakh and send back the report. Use when asked to run the notes benchmark or evaluation, to measure how a change to src/core/notes/ does on real rendered instruments, or to compare a branch against main.
---

# The notes benchmark

`scripts/eval_notes.sh` scores the note detector on BabySlakh: 20 songs, 115 stems rendered from MIDI.
Bass stems are read as one line; piano, guitar, organ and mallets as chords. It downloads the dataset
the first time (about 900 MB into `.dev/`), then writes `.dev/eval/report.md`.

The person asking is usually on a phone and reads the answer, not the terminal.

## 1. Run it

```bash
bash scripts/eval_notes.sh --compare main    # a branch with changes: this checkout against main
bash scripts/eval_notes.sh                   # on main itself, or when asked for the numbers alone
bash scripts/eval_notes.sh --tracks 3        # a quick look, about a minute a run
bash scripts/eval_notes.sh --classes Piano   # one class: Bass, Piano, Guitar, Organ, Chromatic Percussion
```

Default to `--compare main` on any branch that changes `src/core/notes/`: a score alone doesn't say
whether the change helped. A full run is about 15 minutes per side (30 with `--compare`), plus the
download the first time. Start it with `run_in_background`, say it has started and how long it takes,
and wait for it to finish; don't poll with sleep.

A failed run prints the end of its log; the whole log is `.dev/eval/<label>.log`.

## 2. Send the report

**The report is the deliverable.** Send `.dev/eval/report.md` with `SendUserFile` (display `render`), and
put the headline in the reply: F-measure per class, what changed against the base, and the stems that
moved most. Numbers without a comparison don't say whether anything got better; say so when there
was no `--compare`.

## Reading it

- **F** is the harmonic mean of precision (found notes that are real) and recall (real notes found): a
  note counts when its pitch is right and it starts within 50 ms. **F, ends** also needs it to end
  within 20% of its length or 50 ms. All at the starting sensitivity, 55.
- Some Slakh patches sound an octave from their MIDI; each stem is scored at the octave it sounds.
- "time per minute" is detection time per minute of audio; the two sides run one after the other,
  so it compares fairly.
- The detector is deterministic: a commit scores the same every run, so any change is the code's.
