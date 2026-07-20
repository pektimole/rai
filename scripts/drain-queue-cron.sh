#!/bin/bash
# drain-queue-cron.sh — unattended nightly RAI dev-loop runner.
# Fires headless `claude -p "/drain-queue"` from ~/rai repeatedly until Pending
# is empty or a safety cap hits. Mirrors no5-context/scripts/drain-queue-cron.sh,
# but scoped to the rai product repo (commits code, not OLs).
# The cwd = ~/rai is what makes the project-scoped /drain-queue command resolve.
# launchd: com.no5.rai-drain-queue.plist, nightly 03:45 (after no5 drain 03:15).

export PATH="/Users/ich/.nvm/versions/node/v22.19.0/bin:$PATH"
source ~/.bash_profile 2>/dev/null
[ -f /Users/ich/.no5-env ] && source /Users/ich/.no5-env

# .bash_profile / .no5-env set ANTHROPIC_API_KEY, which makes claude prefer the
# API key over OAuth and DISABLES claude.ai connectors. Unset so headless claude
# uses the OAuth session (memory: headless-claude-anthropic-key-disables-connectors).
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN

RAI="/Users/ich/rai"
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
  claude -p "/drain-queue" \
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
