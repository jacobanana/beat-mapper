# BeatMapper in the market

A case study: what the app does, what else does those jobs, what people actually reach for
today, where a standalone browser app fits, and how it could become useful to people other than
its author. Written September 2026 from the product pages, manuals and forum threads linked at the
end; prices and version numbers are as of then.

## What BeatMapper does, as jobs

The app is one pipeline, but each step is a job that people go looking for separately, and each has
its own market. That is the frame for the rest of this document.

| Step | Job the user has | What BeatMapper makes |
| --- | --- | --- |
| Transients | "Find every hit in this recording." | Sample-accurate onsets, editable. |
| Beats | "This was played without a click. Give me the tempo map." | Pins on real transients, beat tracking outward from bar 1, auto-map between pins, a loop that rebuilds the rest. MIDI tempo map with click, REAPER project with the audio in place. |
| Warp | "Make it sit on a straight grid." | Warped `.wav` at one tempo, quantize strength, shuffle, per-hit warp markers. |
| Slice | "Cut it into one-shots." | Zip of `.wav` slices, a `.csv`, optional REAPER project. |
| Groove | "Where does the drummer sit against the beat?" | Kick, snare and hats timed to a fraction of a millisecond, the pocket per voice and per bar, a typical bar, drum MIDI as played, a Pocket Science groove file. |

Two properties cut across all five: everything runs in the browser and the audio never leaves the
machine, and the work is saved per file so it can be picked up later or carried as a `.json`.

## What is in the market

### 1. Tempo map from a free recording

This is the job every DAW claims and few do well. What each one offers today:

- **Logic Pro, Smart Tempo.** The only mainstream DAW where "analyse the audio, get a tempo map"
  is a first-class feature, with a hint mode to fix downbeats afterwards. Users report it works on
  some files and not others, that re-importing the same file can give different results, and that the
  default "smoothed" export hides the beat-level map. The tempo map also stays inside Logic.
- **Pro Tools, Beat Detective.** The studio standard since 2001. It finds transients in a selection,
  builds bar|beat markers, and can cut the audio to the grid. It needs a trained operator, works a few
  bars at a time, and the result is a Pro Tools session.
- **Cubase, Tempo Detection panel.** Automatic, but Steinberg's own notes say it tends to write a
  tempo change on every beat and is not always accurate. The reliable path is still "Merge Tempo from
  Tapping": play the beat on a MIDI key along with the recording, then tidy the map with the Time Warp
  tool.
- **Studio One.** "Detect Tempo" on an event, or Melodyne through ARA, which sends the map back into
  the tempo track. Melodyne's tempo detection is widely thought the best, but the full editor is a
  paid tier and the detection only runs standalone or via ARA.
- **REAPER.** No tempo detection. The documented workflow is manual: Tab to a transient, set a
  marker, select the span, "Create measure from time selection", repeat for the song. Third-party
  scripts help. REAPER users are the audience most likely to search for a tool that does this job.
- **Ableton Live.** Warp markers fit the audio to Live's grid, not the other way round. Ableton's own
  help article on extracting a tempo map says to render a MIDI click and analyse it in Logic or Pro
  Tools. Live has no tempo map export at all.

Outside DAWs the same job shows up under other names:

- **DJ software.** rekordbox's dynamic beatgrid analysis and Serato's "Lucid Beatgrids" (Serato DJ
  5.0 beta, 2026) exist precisely because live drummers drift and a fixed grid fails. Those grids
  live in proprietary libraries.
- **Rhythm-game charting.** Clone Hero and osu! charters tempo-map songs by hand in Moonscraper
  or the osu! editor, one BPM section at a time, and trade "variable BPM calculators" on forums.
- **Research.** Sonic Visualiser with a beat-tracking Vamp plugin, exported as an annotation layer.
  It is the methodological standard in performance research since 2007 but it is an analysis tool,
  not a production one.
- **Libraries.** Open-source beat trackers (madmom, librosa, BeatNet, web-audio-beat-detector,
  rhythm-map for WASM) give a BPM and beat times to developers, with no UI.

**How people actually do it today.** Logic owners use Smart Tempo and fix it by hand. Pro Tools
studios have someone who knows Beat Detective. Everyone else either taps the tempo in (Cubase,
Studio One), does it marker by marker (REAPER), or gives up and edits the audio to a fixed grid
(Ableton). The shared complaint on every forum is the same: the automatic pass is close but not
right, and fixing it means fighting the tool.

### 2. Warping audio to a grid

Every DAW does this well: Ableton warp modes, Logic Flex Time, Pro Tools Elastic Audio, Cubase
AudioWarp, REAPER stretch markers. This is not a job a standalone app can win on its own. In
BeatMapper it matters as the bridge: a warped `.wav` at one tempo is the only form of a tempo map
Ableton will accept.

### 3. Slicing into one-shots

ReCycle is free now, and every DAW slices at transients (Live's Slice to MIDI, FL Studio's Slicex,
Logic's Flex markers). A wave of free browser choppers appeared in 2025 and 2026 (Chppr, TAIL Sampler,
Shuffle Drummer, nok), all aimed at beatmakers who want pads and a quick sketch. Paid plugins
(Initial Slice, Serato Sample) add pitch and playback. Slicing is a commodity; on its own it does not
bring anyone to a new tool.

### 4. Drums to MIDI, with the feel

This market moved in 2025 and 2026 and is the one closest to BeatMapper's Groove step.

- **Drum replacement plugins** (Superior Drummer 3 Tracker, XLN Addictive Trigger, Slate Trigger 2,
  Logic's drum replacement) convert close-miked stems. Reviewers call SD3's Tracker the gold standard
  and in the same breath say it cannot separate a mixed loop and struggles to tell hi-hat from snare.
- **Cloud services** (DrumsMIDI, DrumConvert, Moises' drum stems) upload a full mix, separate it, and
  return MIDI in five to seven minutes. They promise micro-timing and dynamics, work on anything, and
  require sending the audio away.
- **Yurt Rock Pick Pocket** (released 31 August 2026, $49, VST3/AU and standalone, macOS first). Its
  pitch is BeatMapper's pitch: "the feel is the point", unquantized MIDI from any drum recording, and a
  "Pocket lane" that draws each hit's deviation from the grid as a dot you can drag. It is an editor
  for producers who want to reuse a groove, not a measurement of a performance, but it proves there is
  a paying audience for micro-timing shown as a picture.
- **Groove extraction in DAWs** (Live's Extract Groove, Logic's Make Groove Template, Pro Tools'
  groove templates) captures timing and velocity from a clip as a quantize template. Nobody shows
  the user what was extracted.

### 5. Measuring the pocket

- **Practice apps** (Drummer ITP, Melodics, Roland's Coach mode and Time Check) measure a player
  against a click in real time, in milliseconds, and score them. They need the click to exist first;
  they cannot tell you what a record did.
- **Musicology** measures micro-timing from recordings with Sonic Visualiser and onset plugins,
  then spreadsheets. Papers on the Rosanna shuffle, on drummers' individual swing ratios, on hi-hats
  played 2 to 26 ms ahead of the pulse, all do by hand what the Groove step does automatically.
- **Pocket Science** (the author's own groove atlas, 67 grooves) presents this knowledge by ear and by
  transcription, not by measurement. BeatMapper is the instrument it lacked.

Nothing on the market takes a recording with no click, finds the beat, separates kick, snare and
hats, times each to sub-millisecond accuracy and shows where each voice leans, per bar, in a browser,
without uploading. That sentence is the differentiation. Everything else in the app has a competitor
that is good enough.

## The use case for a standalone app

A standalone tool wins when the DAW is the wrong place for the job, or the person has no DAW.

1. **The tempo map is the deliverable, not the session.** A band mapping a rehearsal recording so the
   drummer can play the song to a click next week. A producer who needs bar markers in REAPER or
   Ableton, where no analysis exists. A charter who needs BPM sections. A DJ who wants a grid for a
   live-drummed record. All of them want a file, and BeatMapper's MIDI tempo map, REAPER project and
   warped `.wav` are that file.
2. **The person owns no DAW, or the wrong one.** Drummers, teachers, students and researchers do not
   open Pro Tools to ask "am I rushing the snare?". A URL on a phone is the right shape for them.
3. **The audio cannot leave the machine.** Unreleased mixes, client stems, a teacher's students. Every
   cloud drum-to-MIDI service fails this test; every DAW passes it but makes the user do the work.
   In-browser analysis is the only way to have both.
4. **The map must be pinned to what was played.** DAW tempo detection smooths; Beat Detective and
   Smart Tempo need hand correction. BeatMapper's model of a few pins on real transients, auto-mapping
   between them and a loop that sets the rest, is closer to how an engineer actually fixes a map, and it
   is undoable.
5. **Measurement, not editing.** No production tool tells a drummer where they sit. The Groove step
   turns a phone recording into a report.

## Who else this is for, and what each needs

Ranked by how close the app already is to serving them.

| Segment | What they come for | What they already get | What is missing |
| --- | --- | --- | --- |
| REAPER users | A tempo map from a free take | REAPER project with audio in place; MIDI map | Discoverability. This is the strongest wedge and it is finished. |
| Ableton users | Audio that sits on Live's grid | Warped `.wav` at a whole BPM | Groove export Live can import (a MIDI clip works as a groove source). |
| Bands and live players | A click track from a demo | MIDI click on GM channel 10 | Click as audio (`.wav`) with count-in, so it drops on a phone or a playback rig. |
| Drummers and teachers | "Am I ahead or behind?" | The pocket chart, per voice and bar | Proven accuracy on real kits and rooms; a shareable report (image or link); two takes side by side. |
| Sample-based producers | Slices with the feel kept | Slices, drum MIDI as played, groove file | Drum-library note mappings beyond General MIDI; a Live groove; pad-style audition. |
| Researchers | Onsets and offsets with provenance | Sub-ms timing, cited methods in `docs/groove.md` | CSV of hits and offsets per voice; batch mode; the IDMT-SMT-Drums benchmark published. |
| Charters and DJs | BPM sections and a beatgrid | The tempo map | `.chart`/osu timing points, rekordbox XML. Small formats, underserved, easy. |

## How it could differentiate

### Lead with the one thing nobody else does

The pocket measured from a recording is the unique feature. Tempo mapping is a good on-ramp but it
is one feature among six DAWs' worth; a first-time visitor who lands on "tempo map from a recording"
compares it with Smart Tempo and leaves. A visitor who lands on "drop in your drum take and see
where your snare sits, to the millisecond, without uploading it" has no comparison. Pick Pocket's
launch coverage shows the language that works: "steal the pocket", "the feel is the point".

The home page, the demo and the first screenshot should be the Groove chart of a famous break, with
the tempo map shown as the way to get there.

### Make the measurement trustworthy on real material

The synthetic kit proves the pipeline; the audience above will test it on a phone recording of a
real kit in a room. Before asking anyone else to trust the numbers:

- Run the IDMT-SMT-Drums benchmark named in `docs/groove.md` and publish the hit rate and timing error.
- Ship a fallback the user understands when detection is unsure (hats under a snare, a full mix).
- Keep the full-mix path honest: it is experimental, and the fix is source separation in the browser.
  A Demucs-class model through ONNX Runtime Web is the single biggest unlock, because it turns
  "drum stems and loops" into "any song", which is what every cloud competitor promises.

### Finish the two exports that reach the most people

The MIDI tempo map already imports into Logic, Cubase, Pro Tools, Studio One and REAPER. The two
gaps are Ableton, which will never import a tempo map, and drum software, which wants its own
note mappings.

- Ableton: the warped `.wav` already solves the grid; add a MIDI clip export laid out so Live's
  Extract Groove reads it, and say so on the page.
- Drum libraries: a mapping menu (Superior Drummer, Addictive Drums, EZdrummer, BFD, Slate) on the
  drum MIDI export. Every competitor lists one and it is a table.

### Make the result shareable

A measurement people cannot show is a measurement they do not talk about. A one-image export of the
pocket chart, and a session `.json` that opens from a URL, would let a teacher send a student their
own groove, a producer post a break's pocket, and Pocket Science link an atlas entry to its
measurement. This is how a personal tool gets its second user.

### Publish the core as a library

`src/core` and `src/io` are DOM-free by design and ESLint enforces it. Published as an npm package
they become the only browser-side drum transcription and tempo mapping library with sub-millisecond
timing. Plugin authors, other web apps, Pocket Science itself and researchers can use it without
adopting the UI. It also gives the project a second surface that cannot be compared with a DAW at all.

### Where it should not compete

- Not against DAW warping or slicing. Both are commodities and both are better in place.
- Not against cloud transcription on breadth. Their pitch is "any song, five minutes"; the
  counter-pitch is "your song, your machine, exact", and it should stay that.
- Not on price. A free, open-source, no-account tool is a category of its own next to a $49 plugin and
  a subscription; that position is worth more than a Pro tier until there are users to ask.

## Risks

- **Pick Pocket and its successors.** A funded team put a pocket lane in a plugin in 2026. The next
  version could add analysis. The defence is measurement quality and openness, not features.
- **Browser limits.** Long multitrack sessions, ARA integration and low-latency monitoring are out of
  reach. The app should not promise them.
- **A five-step app is a lot to learn.** Each new segment above enters at a different step. Deep links
  into a step (`#groove`) and a demo per segment would let the same app read as several small tools.
- **One author.** The docs are unusually complete, which helps, but the project's credibility to
  outsiders will rest on published accuracy figures and a stable session format.

## Summary

The market for "tempo map from a free recording" is served, unevenly, inside every DAW; the market
for "measure the pocket of a recording" is served by nobody. BeatMapper has both, in a browser, with
the audio kept local. To be valuable beyond its author it should lead with the measurement, prove it
on real recordings, make the result shareable, ship the Ableton and drum-library exports, and publish
its core as a library. The tempo map stays as the on-ramp for REAPER and Ableton users, who have no
better option today.

## Sources

DAW tempo mapping: [Logic's Smart Tempo (Sound on Sound)](https://www.soundonsound.com/techniques/logics-smart-tempo-part-1),
[Smart Tempo deep dive](https://whylogicprorules.com/smart-tempo-deep-dive/),
[Smart Tempo is unusable for me (Gearspace)](https://gearspace.com/board/apple-logic-pro/1226139-smart-tempo-unusable-me.html),
[Smart Tempo problem (Apple Community)](https://discussions.apple.com/thread/252696721),
[Tempo maps for pre-recorded audio, Cubase (SOS)](https://www.soundonsound.com/techniques/tempo-maps-pre-recorded-audio),
[Cubase Tempo Detection (Steinberg help)](https://www.steinberg.help/r/cubase-pro/15.0/en/cubase_nuendo/topics/editing_tempo_and_signature/editing_tempo_tempo_detection_c.html),
[Pro Tools Beat Detective tempo mapping (SOS)](https://www.soundonsound.com/techniques/pro-tools-tempo-mapping-beat-detective),
[Find tempo with Beat Detective (Avid)](https://www.avid.com/pro-tools/user-guide/find-tempo),
[Tempo mapping with Melodyne in Studio One (SOS)](https://www.soundonsound.com/techniques/tempo-mapping-melodyne-studio-one),
[Melodyne tempo detection](https://helpcenter.celemony.com/M5/doc/melodyneStudio5/en/M5tour_TempoDetectionIntro_2?env=standAlone),
[Extracting a tempo map from Live (Ableton)](https://help.ableton.com/hc/en-us/articles/360000046760-Extracting-a-Tempo-Map-from-Live),
[Finding song tempo in REAPER](https://publish.obsidian.md/arendleejessurun/Atlas/Music+production/Reaper/Finding+song+tempo+in+Reaper),
[REAPER custom tempo maps (Gearspace)](https://gearspace.com/board/cockos-reaper/1382246-reaper-technique-custom-tempo-maps.html).

DJ, charting, research: [rekordbox beatgrid analysis](https://www.lexicondj.com/blog/understanding-rekordbox-beatgrid-analysis),
[Serato Lucid Beatgrids](https://www.notebookcheck.net/Serato-DJ-finally-learns-how-to-follow-real-drummers.1399341.0.html),
[osu! timing guide](https://osu.ppy.sh/wiki/en/Guides/How_to_time_songs),
[Moonscraper](https://moonscraper.org/),
[Sonic Visualiser](https://github.com/sonic-visualiser/sonic-visualiser),
[Sonic Visualiser in performance research (JAMS)](https://online.ucpress.edu/jams/article/74/3/701/119252/Sonic-Visualiser-Visualisation-Analysis-and),
[Timing and dynamics of the Rosanna shuffle](https://arxiv.org/pdf/2411.06892),
[rhythm-map SDK](https://github.com/NagareWorks/rhythm-map).

Slicing: [ReCycle (free)](https://www.reasonstudios.com/recycle), [Chppr](https://chppr.app/),
[TAIL Sampler](https://tailsampler.com/sample-chopper/), [Initial Slice](https://initialaudio.com/slice/).

Drums to MIDI and groove: [Pick Pocket (Yurt Rock)](https://yurtrock.com/products/pick-pocket-the-audio-to-midi-drum-plug-in),
[Pick Pocket launch (Bedroom Producers Blog)](https://bedroomproducersblog.com/2026/09/04/yurt-rock-pick-pocket/),
[Pick Pocket pocket lane](https://robsonic.org/why-yurt-rock-pick-pocket-lets-producers-steal-a-drum-grooves-human-pocket/),
[Superior Drummer 3 Tracker (SOS)](https://www.soundonsound.com/reviews/toontrack-superior-drummer-3),
[Mixed drum audio to MIDI (VI-Control)](https://vi-control.net/community/threads/mixed-drum-audio-to-midi.166145/),
[Addictive Trigger](https://www.xlnaudio.com/products/addictive_trigger),
[DrumsMIDI](https://drumsmidi.com/),
[Moises](https://moises.ai/features/stems-vst-plugin/),
[Samplab shutting down](https://selektaudio.com/guides/samplab-alternative),
[Live's grooves](https://www.ableton.com/en/manual/using-grooves/),
[Logic groove templates](https://support.apple.com/guide/logicpro/create-groove-templates-lgcp3fe6a76e/mac).

Timing practice: [Drummer ITP](https://www.idrumtune.com/drummer-itp/),
[Melodics timing feedback](https://melodics.com/drums),
[Roland Coach mode](https://www.rolandmusiced.com/spotlight/article.php?ArticleId=1723),
[Pocket Science](https://github.com/jacobanana/pocket-science).
