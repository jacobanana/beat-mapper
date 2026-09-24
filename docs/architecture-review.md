# Architecture review, September 2026

A review of the whole of `src/` after the Warp, Slice and Groove steps started sharing the warp
(#12 to #16). It looks for mixed concerns, duplication, things likely to drift apart, and coupling:
both coupling that is there and shouldn't be, and coupling that should be there and isn't. File
references are to `main` at 127841e.

## In short

The layering holds up. `core/` is pure and ESLint keeps it that way, derived data is memoised on the
identity of its inputs and never stored, and `Timeline` together with its lint rules settled *where* a
moment is drawn. What is still loose is **which audio is heard**. Three places answer that question,
each on its own:

| Question | Who answers | Read by |
| --- | --- | --- |
| Should the warp be heard? | `App.hearingWarp` (`app.ts:242`), derived | timeline, `warpOut`, slices, pocket, readout, exports |
| Is the warp heard right now? | `Playback.take` (`playback.ts:101`), set only by `play()` | audio position, synth kit, metronome |
| What does the W button show? | `app.warp.listen` (`header.ts:104`) | the top bar |

Only `Warp.follow()` (`warp.ts:48`, `warp.ts:346`) keeps the first two in step, and it runs on a
hand-kept list of eight topics. Most of the recent warp bugs came from these answers disagreeing
(6cdf1fc, and the readout, click and loop-a-bar fixes in 5213165). The other recurring cause is
**dependency lists kept by hand**: which topics a panel listens to, what a render depends on, which
fields opening a file resets. Nothing checks those lists against the memoised getters they have to
match.

Findings, most important first. Two of them are bugs I found by reading the code and have not
reproduced in a browser: stale Groove and Slice panels (§3), and the grid tempo carrying over to the
next file (§5).

---

## 1. "What is heard" has three owners

`hearingWarp` becomes true as soon as the warp is *wanted*. The take is only *playing* once it has
been rendered, and after an edit the old take keeps playing until the new one is ready (by design,
`playback.ts:89`). So there are windows where the screen is drawn from one take and the speakers play
another:

- **While the first render runs.** It takes up to about 16 s for a three-minute song in Full mix. The
  original plays, but the timeline already draws the audio moved (`app.ts:257`), the readout gives the
  grid's BPM (`Timeline.bpmAt`), and the metronome clicks the tempo map's beats, because `clicksIn`
  only uses the take's grid when there is a take (`playback.ts:195`). With warp markers in place,
  those clicks miss the grid lines drawn. This is the bug 5213165 fixed for the settled state, still
  present while the render runs.
- **After an edit while playing** (quantize strength, a pin nudge, the grid tempo). The timeline is
  on the new alignment straight away, while the old take plays for as long as the re-render takes. The
  playhead is the old take's `toSource()` drawn through the new alignment.
- **When a render fails.** `prepare()` sets `warp.listen = false` (`warp.ts:328`). A playback failure
  quietly changes a setting, and with it what Slice and Groove cut, measure and export.
- **The W button** shows the setting, not what is heard: it stays pressed in Transients and Beats, and
  in the Warp step with no plan (loop-only warp, loop off).
- **The metronome's rule depends on the take.** Slice clicks the transients over the original
  (`playback.ts:198`) but the grid over the warp (`take.clicks` doesn't look at the step).
- **Scrubbing and `,` / `.` always sound the original buffer** (`playback.ts:269`, `:285`). That is
  usually right, since it is the same moment of the audio, but in Re-pitch mode the pitch is not what
  plays.

`test/timeline.test.ts` checks drawn against heard only once the take is rendered and playing, so none
of these windows is covered by a test.

**Recommendation: one value for what is heard.** Give the app a `heard` value that everything reads
(timeline, clicks, synth kit, scrub, readout, W button):

```ts
type Heard =
  | { kind: 'original' }
  | { kind: 'warp'; out: WarpOut; alignment: Alignment; take: Take | null };
```

- While playing, `heard` is **what plays**: the take's `Render` keeps the alignment and plan it was made
  from, so the timeline can be built from those rather than from the doc as it is now. While stopped,
  it is what is wanted. This closes the render and stale-take windows: the screen follows the
  speakers, then moves on to the new warp when the new take starts.
- `Playback` asks `heard` for its buffer, time mapping, clicks and grains, so it has no warp logic of
  its own. `TakeSource` plus `follow()` become one reconciler whose only job is to make what plays
  match what is wanted.
- A failed render leaves `warp.listen` alone. The app reports `heard = original` along with the
  reason, and the button shows it.
- Add timeline tests for the pending state (warp wanted, not yet rendered) and for the stale state
  (edited while playing): what is drawn must still be what is heard.

## 2. The warp's geometry is worked out in several places

The same facts about one warp are computed separately, sometimes in slightly different ways:

| Fact | Where |
| --- | --- |
| The source range warped, `{a: src[0], b: src[last]}` | `app.ts:247`, `warp.ts:224`, `warp.ts:334`, `warp.ts:413`, `layers.ts:295` |
| Source time to warped time | `WarpOut.at` (unclamped, `app.ts:247`) and `Take.toTake` (clamped, `warp.ts:338`): slices and the pocket use one, the audio uses the other |
| The straight grid | `gridMap(q0, bpm)` in `WarpOut.map`, `gridBeats(q0, bpm, meter)` in `Take.clicks`, a third beat loop over the tempo map in `Playback.clicksIn`, and a fourth (sixteenths) in `Warp.transients()` |
| The tempo map a DAW gets | `slicer.ts:229` and `groove.ts:193`, which differ: one passes `trimmed: false`, the other relies on `exportMap` |
| `out ? out.at(t) : t` | `export-dialog.ts:116`, `:128`, `:137`, `slicer.ts:156`, `groove.ts:192`, and the identity `Cut` in `Slicer.cut` |

**Recommendation.** Put `range`, a single `at` (clamped once, the same way for audio and data), the
grid's beats and the export map on `WarpOut`, and build the `Take` from the `WarpOut`, not from the
raw `WarpMap`. Give the original a `WarpOut`-shaped identity (`at = t`, `map = tempoMap`,
`exportMap = tempoMap`), so the Slice, Groove and export dialog code stops branching on `out ?`.
Folded into `Heard` (§1), each of these facts has one definition.

## 3. Redraw topics kept by hand

The getters on `App` recompute correctly. But each panel lists the topics it redraws on, and to get
that list right it has to know everything the getter depends on, directly or through other getters.
`warpOut` depends on `step`, `warp`, `doc`, `transport` (the loop), `export` (the lead-in) and
`audio`, so any panel showing slices or the pocket needs all six. Several have fewer:

- **Groove panel summary** (`groove-panel.ts:42`) and **groove chart** (`groove-chart.ts:25`) don't
  listen to `'warp'` or `'export'`. Pressing W or changing the grid tempo in Groove leaves the pocket's
  BPM and chart showing the other take until something else redraws them.
- **Slice panel** (`slice-panel.ts:121`) doesn't listen to `'warp'` or `'export'`. Pressing W in
  Slice changes `app.slices` (they are clipped to the warp's range) but not the list or the count. Its
  times and lengths are also the original's, while the export dialog (`export-dialog.ts:116`) and
  `zipEstimate` show the warped file's, and its loop BPM is the tempo map's rather than the one heard
  (`Slicer.loopHeard` has the right one).
- **Readout** (`header.ts:111`) misses `'export'`: trimming the lead-in can change the grid BPM of the
  plan.

The editor canvas never has this problem because it listens to `'*'` and redraws at most once a
frame.

**Recommendation.** Either (a) let panels do the same: mark themselves dirty on `'*'` and re-sync the
visible panel once a frame (cheap, and it can't drift), or (b) have `App` emit a derived `'heard'`
topic whenever `warpOut`'s identity changes, so a panel listens to one topic instead of six. I'd do
(a) for the panels and keep the fine-grained topics for features, where acting on every event costs
something.

The same pattern shows up in `Warp.inputs()` (`warp.ts:370`), where what a render depends on is
listed next to the memo that makes the plan rather than derived from it. It is correct today.

## 4. The rules for each step are spread across the code

There are 48 comparisons like `app.step === 3` or `step >= 2` across 11 files. The ones that decide
what is heard or drawn are:

- which steps can hear the warp: `step >= 3` (`app.ts:242`)
- metronome on transients: `step === 1 || step === 4` (`playback.ts:198`)
- synth kit: `step === 5 && !!app.drums`, written twice (`playback.ts:56`, `mixer-panel.ts:40`)
- tempo lane grid overlay: `step === 3`, independent of whether the warp is heard (`layers.ts:267`)
- editable half and faded markers: `step <= 3`, `step >= 2` (`editor-renderer.ts:75`)

`Step` itself is declared in `io/session.ts:15`, so the app's central notion comes from the file
format.

**Recommendation.** Add `app/steps.ts` with one table (`hearsWarp`, `clicks: 'markers' | 'beats'`,
`kit`, `editable`, `recedeMarkers`, …) and have these call sites read the table. `Step` moves there
too, and `io/session.ts` imports it.

## 5. What belongs to a file, and what a session keeps

- **Opening a file** resets a hand-kept list of `App` fields (`loader.ts:75`). The warp settings
  aren't on it, so `warp.bpm`, the grid tempo set with *From loop*, carries over from the last file to
  the next. The same goes for `warp.range`, `warp.mode`, `warp.listen` and `warpDrag`. A file with no
  saved session also keeps the last file's shuffle.
- **Sessions** save the warp markers and quantize strength but not `warp.listen`, `bpm`, `mode` or
  `range` (`sessions.ts:43`), even though these decide what Slice and Groove export. A session reopened
  in Slice or Groove can export different files from the ones it exported before it was closed.
  CLAUDE.md's rule for settings covers them (write only when not the default, no version bump), and
  `warp.md` lists them under Later.
- Hit edits (`doc.drums`) can be undone but aren't in the session (`sessions.ts:118`).

**Recommendation.** Split `App` state explicitly into *per file* (reset from defaults in one
`App.load(asset)`), *per device* (the mixer) and *per visit* (mutes), so the session content can be
built from the per-file group. Then save the four warp settings under the existing rule.

## 6. Feature coupling

- **`Warp` does four jobs in 467 lines**: editing (markers, quantize), the render cache, the take
  source, and switching what plays. Slicer and the Warp step's export only need the render. Warp
  imports `sliceRenderOptions` from `slicer.ts`, and Slicer imports the `Warp` type: a module cycle,
  harmless for now because one side imports only a type.
- `Warp.reset` writes `beats.shuffle` (`warp.ts:110`). The two steps share one grid, so this is
  deliberate, but it means Beats' state has two writers.
- `Exports.options()` returns the tempo map's options, and every warped caller spreads its own
  overrides on top (§2).

**Recommendation.** Split `Warp` into `WarpEdit` (settings, markers, quantize) and `WarpRender` (render
cache and take), and have the reconciler from §1 own switching what plays. Move
`sliceRenderOptions` to `core/slices` or `state/settings`.

## 7. Smaller things

- **When a loop counts**: `activeLoop` (`app.ts:266`) and `_range` (`app.ts:165`) each check
  `> 0.01`. `Playback.play` loops `transport.loop` without that check (`playback.ts:101`), and
  `fromLoop` uses `0.05`. Reading `activeLoop` everywhere would give one answer.
- `pointer.ts` and `editor-renderer.ts` each compose `view` with `timeline` for `xOf`/`tOf`. A small
  shared `screen(app)` helper would keep the two from diverging.
- `WarpPlan` and `WarpOut` are declared in `app.ts` and `Render` in `features/warp.ts`. They could
  live next to `Heard`.
- `Timeline.bpmAt` gives the grid BPM for every time, including outside a loop-only warp, where the
  original plays.

## What is solid

- The ESLint layering, and the lint rules that send time placement through `Timeline`.
- Derived data memoised on input identity and never stored: `App` has no stale caches.
- Undo through one immutable document, and drags as a checkpoint followed by unrecorded edits.
- `test/parity.test.ts` against the legacy code, and `test/timeline.test.ts` as an executable
  statement of "what is drawn is what is heard".

## Suggested order

1. **Small bug fixes, one PR**: the panel topics (§3) or the per-frame panel sync, resetting the warp
   settings on open (§5), the W button showing what is heard (§1), and `Playback.play` using
   `activeLoop` (§7).
2. **`Heard`** (§1 and §2), with pending-render and stale-take cases added to `test/timeline.test.ts`.
   This is the change that stops the class of warp bugs.
3. **The step table** (§4). Mechanical, and it makes step 2 easier to review.
4. **The warp settings in the session** (§5).
5. **Splitting `Warp`** (§6), once `Heard` has taken the playback switching out of it.
