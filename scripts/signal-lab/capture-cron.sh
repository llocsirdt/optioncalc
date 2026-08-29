#!/bin/bash
# Recurring 1m (+5m/15m) NDX capture for the growing v4 out-of-sample dataset.
# Schwab only serves 1m data ~48 days back, so this must run at least every few weeks to avoid gaps
# (scheduled daily on weekdays via com.optioncalc.ndx-capture LaunchAgent). fetch-history.js only
# writes NEW day-files, so re-runs are cheap/idempotent. Requires a live SCHWAB_REFRESH_TOKEN in .env
# (Schwab refresh tokens last ~7 days — when it expires the fetch errors and this logs it; capture
# resumes automatically once the token is refreshed, and the 48-day window tolerates the gap).
#
# INSTALL NOTE: this file is the source of truth, but the LaunchAgent CANNOT exec it from ~/Documents
# (macOS TCC blocks background agents from reading files under the protected Documents folder). It is
# installed (copied) to ~/Library/Application Support/optioncalc/ — outside TCC — which is what
# launchd runs. node's RUNTIME reads/writes into the repo are fine; only exec-from-Documents is
# blocked. The log therefore also lives outside ~/Documents. Re-run the install copy after editing:
#   cp scripts/signal-lab/capture-cron.sh "$HOME/Library/Application Support/optioncalc/"
set -uo pipefail

REPO="/Users/tdriscoll/Documents/surf/optioncalc"
NODE="/usr/local/bin/node"
LOG="$HOME/Library/Logs/optioncalc-capture.log"   # OUTSIDE ~/Documents (TCC) so a launchd agent can write it
mkdir -p "$HOME/Library/Logs"
cd "$REPO" || { echo "$(date '+%F %T') FATAL: cannot cd $REPO" >>"$LOG"; exit 1; }

echo "===== $(date '+%F %T %Z') capture start =====" >>"$LOG"
for freq in 1 5 15; do
  echo "--- fetch NDX ${freq}m ---" >>"$LOG"
  "$NODE" scripts/signal-lab/fetch-history.js NDX --freq "$freq" --days 45 >>"$LOG" 2>&1
done

echo "--- rebuild v4 analysis dataset ---" >>"$LOG"
"$NODE" scripts/candle-spread/build-analysis-dataset.js NDX >>"$LOG" 2>&1

echo "===== $(date '+%F %T %Z') capture done =====" >>"$LOG"
# Keep the log from growing without bound (last ~2000 lines).
tail -n 2000 "$LOG" >"$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"
