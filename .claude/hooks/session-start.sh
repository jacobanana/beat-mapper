#!/usr/bin/env bash
# SessionStart: get the checkout ready to be checked, without making the
# session wait for it.
#
# A container is cloned fresh for every web and mobile session, which leaves
# no node_modules — and until that exists, `npm test` and `tsc` fail for
# reasons that have nothing to do with the change being made. An agent that
# meets those failures cold will debug them, and the transcript that comes
# back to your phone is twenty minutes of a solved problem.
#
# Preparation takes minutes on a cold container and milliseconds on a warm
# one, so it runs detached here and `scripts/await_ready.sh` is what blocks
# on it. The hook itself must return in seconds: it is in front of the first
# prompt.
set -uo pipefail

repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
cd "$repo_root" || exit 0

run_dir="$repo_root/.dev"
mkdir -p "$run_dir"

if [[ -f "$run_dir/prepared" ]]; then
  context="The dev environment is already prepared."
else
  # setsid detaches it from the session's process group, so the hook can
  # return now and the work survives.
  detach=()
  command -v setsid >/dev/null && detach=(setsid)
  "${detach[@]}" nohup bash scripts/await_ready.sh >"$run_dir/prepare.log" 2>&1 </dev/null &
  disown $! 2>/dev/null || true

  context="Preparing the dev environment in the background (npm ci). Log: .dev/prepare.log"
fi

# The hook's real payload: a sentence in the model's context, at the top of
# the session, saying what to do about all this.
jq -n --arg context "$context" '{
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: ($context + "\n\nBefore running any check or starting the app, run `bash scripts/await_ready.sh` — it returns immediately when preparation is done and blocks until it is when it is not. Do not diagnose a failing `npm run check`, `tsc` or `vitest`, or a missing module, before it has returned.")
  }
}'
