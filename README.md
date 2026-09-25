# 🥁 BeatMapper

Tempo map from a recording. Drop in the audio, let it find every hit, set bar 1 and it follows the
beat from there, pinning each beat to a real transient. Loop the part that feels right and it
rebuilds the rest to match. Exports a MIDI tempo map (with a click track) or a REAPER project with
the audio already in place, slices the audio into one-shot samples, and keeps a per-file session so
you can pick up where you left off.

**Live:** https://jacobanana.github.io/beat-mapper/

**Groove** (step 5) shows the pocket of a drum performance from real measurements: it finds the
kick, snare and hats, times every hit to a fraction of a millisecond, and shows where each voice sits
against the beat, ahead or behind, bar by bar and in a typical bar drawn the way
[Pocket Science](https://github.com/jacobanana/pocket-science) draws its grooves. The drums export
as MIDI with every hit where it was played, or as a Pocket Science groove file. It works on drum
stems and loops; a full mix is experimental (see [docs/groove.md](docs/groove.md)).

**Notes** (step 6) turns a bass line, a lead or chords into MIDI: every note with its pitch, start,
length, velocity and bends, found by signal processing rather than a trained model, drawn as a piano
roll and heard on a synth voice. It works best on one instrument on its own (see [docs/notes.md](docs/notes.md)).

It started as a single HTML file in [jacobanana/appz](https://github.com/jacobanana/appz) and moved
here to grow. Everything runs in the browser; audio never leaves the machine.

## Working on it

```sh
npm install
npm run dev          # http://localhost:5173/beat-mapper/
npm run check        # typecheck + lint + unit tests
npm run build        # dist/, what GitHub Pages serves
npm run e2e          # after a build: walks the demo loop through every step in Chromium
```

Pushing to `main` runs CI and deploys to GitHub Pages (`.github/workflows/`).

## How it's put together

The audio-editing logic is a plain TypeScript library with no DOM in it (`src/core`, `src/io`); the
app state and features sit on top of it (`src/state`, `src/app`), and the UI on top of that
(`src/ui`). The analysis runs in a Web Worker. See [docs/architecture.md](docs/architecture.md).

## What it keeps in the browser

One `localStorage` entry per audio file (`beatmapper:s:<file name>|<length in ms>`), holding the
markers, pins, warp markers and settings of the last eight files, plus an index of which those are
(`beatmapper:index`). Never the audio. The Notes step's settings and deleted notes are saved with the session; the notes themselves are found
again when the step opens. The Groove step's settings aren't saved yet; the drums are
found again when the step opens. The mixer's levels are kept under `beatmapper:mix`. **Session**
in the Export window saves the same thing as a `.json` file to carry the work to another device. The format is the single-file app's, with
the warp markers added in a field it ignores, and so are the keys, so work saved there comes back here.
