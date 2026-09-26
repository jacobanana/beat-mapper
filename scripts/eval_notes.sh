#!/usr/bin/env bash
# The note detector's benchmark, on demand: fetches BabySlakh if it isn't here yet, scores this checkout
# on it, and writes one report. With --compare, it scores another commit the same way (the same harness,
# that commit's detector) and the report sets the two side by side.
#
#   bash scripts/eval_notes.sh                     # this checkout
#   bash scripts/eval_notes.sh --compare main      # this checkout against main
#   bash scripts/eval_notes.sh --tracks 3          # the first 3 songs only: a quick look
#   bash scripts/eval_notes.sh --classes Piano,Bass
#
# The report is .dev/eval/report.md, beside the per-stem tables of each run (notes-<label>.md). About
# 15 minutes a run for all 20 songs; the first time also downloads about 900 MB.
set -euo pipefail

repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || repo_root=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo_root"

compare="" tracks="" classes=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --compare) compare="${2:?--compare needs a branch, tag or commit}"; shift 2 ;;
    --tracks) tracks="${2:?--tracks needs a number}"; shift 2 ;;
    --classes) classes="${2:?--classes needs a comma-separated list}"; shift 2 ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "eval_notes: unknown option $1 (see --help)" >&2; exit 2 ;;
  esac
done

# In a session the environment may still be installing; CI has just run npm ci itself.
[[ -n "${CI:-}" ]] || bash scripts/await_ready.sh
dataset="${SLAKH:-$repo_root/.dev/babyslakh_16k}"
if [[ ! -d "$dataset" ]]; then
  if [[ -n "${SLAKH:-}" ]]; then echo "eval_notes: no dataset at $SLAKH" >&2; exit 1; fi
  bash scripts/fetch_slakh.sh
fi
dataset=$(cd "$dataset" && pwd -P)
out="$repo_root/.dev/eval"
mkdir -p "$out"

# A name for a run: the ref and its commit, safe in a file name.
label_of() { printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '-'; }
here_rev=$(git rev-parse --short HEAD)
here_name=$(git rev-parse --abbrev-ref HEAD)
[[ "$here_name" == "HEAD" ]] && here_name="detached"
here_label=$(label_of "${here_name##*/}-$here_rev")
if [[ -n $(git status --porcelain -- src bench) ]]; then here_label="$here_label-local"; fi

# One run of the harness in the checkout at $1, labelled $2.
run() {
  local dir="$1" label="$2" started=$SECONDS
  echo "== scoring $label (log: .dev/eval/$label.log)"
  if ! (cd "$dir" && SLAKH="$dataset" LABEL="$label" OUT="$out" TRACKS="$tracks" CLASSES="$classes" \
        npx vitest run --config bench/vitest.config.ts bench/slakh.eval.ts >"$out/$label.log" 2>&1); then
    echo "eval_notes: the run of $label failed; the end of its log:" >&2
    tail -n 30 "$out/$label.log" >&2
    exit 1
  fi
  echo "   done in $(( (SECONDS - started) / 60 )) min"
}
run "$repo_root" "$here_label"

base_json=""
if [[ -n "$compare" ]]; then
  # A branch is compared as it is on GitHub now: the local copy of main is often long out of date.
  git fetch --quiet origin "$compare" 2>/dev/null || true
  if git rev-parse --verify --quiet "refs/remotes/origin/$compare^{commit}" >/dev/null; then compare="origin/$compare"; fi
  base_rev=$(git rev-parse --verify --quiet "$compare^{commit}") || { echo "eval_notes: no commit $compare" >&2; exit 1; }
  base_label=$(label_of "${compare##*/}-$(git rev-parse --short "$base_rev")")
  base_dir="$repo_root/.dev/eval-base"
  git worktree remove --force "$base_dir" 2>/dev/null || rm -rf "$base_dir"
  git worktree add --quiet --detach "$base_dir" "$base_rev"
  trap 'git -C "$repo_root" worktree remove --force "$base_dir" 2>/dev/null || true' EXIT
  ln -s "$repo_root/node_modules" "$base_dir/node_modules"
  # The same harness on both sides, so only the detector differs; the other commit needs its notes module.
  # Only the benchmark itself runs there: the tuning harness beside it reads this checkout's detector.
  rm -rf "$base_dir/bench" && cp -r "$repo_root/bench" "$base_dir/bench"
  if [[ ! -f "$base_dir/src/core/notes/detect.ts" ]]; then echo "eval_notes: $compare has no note detector to score" >&2; exit 1; fi
  run "$base_dir" "$base_label"
  base_json="$out/notes-$base_label.json"
fi

scope="all 20 songs"
[[ -n "$tracks" ]] && scope="the first $tracks songs"
[[ -n "$classes" ]] && scope="$scope, $classes only"
note="Run $(date -u '+%Y-%m-%d %H:%M UTC') on $scope: **$here_label**${compare:+ against **$base_label** ($compare)}."
node bench/report.mjs "$out/notes-$here_label.json" ${base_json:+"$base_json"} --note "$note" >"$out/report.md"
echo
cat "$out/report.md"
echo
echo "Report: .dev/eval/report.md"
