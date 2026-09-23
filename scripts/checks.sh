#!/usr/bin/env bash
# The commit gate — one home for the fast quality checks, shared by the Claude
# PreToolUse hook, by CI, and by anyone typing `make checks`.
#
#   bash scripts/checks.sh
#
# Prints a failure report and exits 1; exits 0 silently on success.
# Silence is the pass.
#
# One home is the entire point. A hook with its own copy of the command list
# drifts from CI within a fortnight, and the drift is only ever discovered by
# a pull request that was green locally.
#
# What belongs here: everything fast enough to sit between a change and a
# commit — lint, format, types, unit tests. What does not: anything needing a
# database, a browser or a minute. Those are the pre-PR gate; see CLAUDE.md.
set -uo pipefail

repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || repo_root=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo_root"

failures=()
report=""

run() {
  local label="$1"; shift
  local out
  if ! out=$("$@" 2>&1); then
    failures+=("$label")
    # Tail, not the whole thing: the report is read back by an agent with a
    # context window, and the last 40 lines are where the error is.
    report+=$'\n'"--- $label ---"$'\n'"$(tail -n 40 <<<"$out")"$'\n'
  fi
}

if [[ ! -d node_modules ]]; then
  echo "Checks failed: no node_modules — run 'bash scripts/await_ready.sh' first."
  exit 1
fi

# The same three legs as `npm run check`, run separately so the report names
# which one went red instead of stopping at the first.
run "tsc --noEmit" npm run --silent typecheck
run "eslint" npm run --silent lint
run "vitest" npm test --silent

if [[ ${#failures[@]} -gt 0 ]]; then
  echo "Checks failed: ${failures[*]}"
  echo "$report"
  exit 1
fi
