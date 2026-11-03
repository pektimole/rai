#!/bin/bash
# drain-queue-cron.sh — unattended nightly RAI dev-loop runner.
# Fires headless `claude -p "/drain-queue-rai"` from ~/rai repeatedly until Pending
# is empty or a safety cap hits. Mirrors a workspace-level drain-queue-cron.sh,
# but scoped to the rai product repo (commits code, not tracker entries).
# Command is named /drain-queue-rai (not /drain-queue): the global user-level
# /drain-queue command shadows same-named project commands in headless `claude -p`
# invocations regardless of cwd — confirmed 2026-07-20, a same-named project
# command silently resolved to the global one for 10 iterations, no-op.
# launchd: com.rai.drain-queue.plist, nightly 03:45 (after the workspace drain at 03:15).
# Overrides: RAI_DIR (repo path), RAI_NODE_BIN (node bin dir), RAI_ENV_FILE (env file to source).

export PATH="${RAI_NODE_BIN:-$HOME/.nvm/versions/node/v22.19.0/bin}:$PATH"
source ~/.bash_profile 2>/dev/null
RAI_ENV_FILE="${RAI_ENV_FILE:-$HOME/.rai-env}"
[ -f "$RAI_ENV_FILE" ] && source "$RAI_ENV_FILE"

# .bash_profile / the env file may set ANTHROPIC_API_KEY, which makes claude prefer the
# API key over OAuth and DISABLES claude.ai connectors. Unset so headless claude
# uses the OAuth session.
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN

RAI="${RAI_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
LOG="$RAI/scratch/drain-queue-cron.log"
LOCK="$RAI/scratch/.drain-queue-cron.lock"
MAX_ITER=10   # safety cap: at most 10 jobs drained per nightly run

mkdir -p "$RAI/scratch"
cd "$RAI" || { echo "$(date -u +%FT%TZ) FATAL cd failed" >> "$LOG" 2>/dev/null; exit 1; }

# Prevent overlapping runs (prior cron still executing, or Tim mid-`/loop /drain-queue`).
if [ -f "$LOCK" ]; then
  AGE=$(( $(date +%s) - $(stat -f %m "$LOCK" 2>/dev/null || echo 0) ))
  if [ "$AGE" -lt 7200 ]; then
    echo "$(date -u +%FT%TZ) SKIP lock held (age ${AGE}s)" >> "$LOG"
    exit 0
  fi
  echo "$(date -u +%FT%TZ) stale lock (age ${AGE}s), reclaiming" >> "$LOG"
fi
echo $$ > "$LOCK"
trap 'rm -f "$LOCK"' EXIT

TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
echo "[$TS] rai-drain-queue-cron START" >> "$LOG"

git fetch origin main >> "$LOG" 2>&1
git rebase --autostash origin/main >> "$LOG" 2>&1

# Nothing to do? Skip the (costly) claude invocation entirely.
if ! grep -q '^- \[ \]' queue.md 2>/dev/null; then
  echo "[$TS] rai-drain-queue-cron no-op, Pending empty" >> "$LOG"
  exit 0
fi

i=0
while [ "$i" -lt "$MAX_ITER" ]; do
  i=$((i+1))
  echo "[$TS] rai-drain-queue-cron iteration $i" >> "$LOG"
  # Hermetic tool surface: no send/publish/deploy/Slack/Gmail tools in this
  # allowlist at all, so the drain physically cannot cross those gates
  # regardless of what a job or injected content tries — belt-and-suspenders
  # on top of the command's own gate step.
  claude -p "/drain-queue-rai" \
    --model sonnet \
    --allowedTools "Read" "Write" "Edit" "Bash" "WebFetch" "WebSearch" \
    >> "$LOG" 2>&1
  RC=$?
  echo "[$TS] iteration $i exit $RC" >> "$LOG"
  git fetch origin main >> "$LOG" 2>&1
  git rebase --autostash origin/main >> "$LOG" 2>&1
  if ! grep -q '^- \[ \]' queue.md 2>/dev/null; then
    echo "[$TS] rai-drain-queue-cron Pending empty, stopping after $i iteration(s)" >> "$LOG"
    break
  fi
done

echo "[$TS] rai-drain-queue-cron DONE ($i iteration(s) run)" >> "$LOG"
