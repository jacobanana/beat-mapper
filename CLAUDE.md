# BeatMapper

Vite + TypeScript, no UI framework. Read `docs/architecture.md` before changing structure.

- `npm run check` (typecheck, lint, unit tests) must pass; `npm run build && npm run e2e` for UI changes.
- Layering is enforced by ESLint: `src/core` and `src/io/formats` must not touch the DOM, Web Audio,
  `app/`, `ui/`, `engine/` or `state/`.
- `ProjectDoc` is immutable. Change it only through `app.edit(fn)` (recorded for undo) or
  `app.edit(fn, false)` after an `app.checkpoint()` (drags).
- Derived data (markers, bars, slices, tempo map) is computed by getters on `App`; don't cache it
  elsewhere.
- `test/legacy/` is the original single-file app's code, kept verbatim for the parity tests. Don't
  edit it.
- Session JSON (`io/session.ts`) and the `beatmapper:*` localStorage keys are shared with saved user
  work: keep reading old versions.
- Comments explain why, in plain sentences, like the existing ones.
