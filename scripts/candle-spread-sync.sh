#!/bin/bash
# Mirror prod's candle-spread runs into the local archive. Driven by the LaunchAgent in
# scripts/com.optioncalc.run-sync.plist, which fires after the close each weekday.
#
# INSTALL NOTE: this file is the source of truth, but the LaunchAgent CANNOT exec it from ~/Documents —
# macOS TCC blocks background agents from reading files under the protected Documents folder, and the
# agent fails with exit 126 / "Operation not permitted". It must be COPIED to
# ~/Library/Application Support/optioncalc/ and the plist pointed there, exactly as capture-cron.sh
# already is. node's RUNTIME reads and writes into the repo are fine; only exec-from-Documents is blocked.
# Re-copy after editing this file:
#   cp scripts/candle-spread-sync.sh ~/Library/Application\ Support/optioncalc/
#
# WHY THIS EXISTS. The sync script was written but never scheduled, so it only ran when someone
# remembered. It last ran around 2026-09-08. When an EB instance replacement wiped /var/optioncalc-data
# at 00:12Z on 2026-09-16, the runs for 09-09 through 09-14 went with it -- they had never been mirrored
# anywhere, and they are gone. The store lives on instance-local disk, so the local archive is the ONLY
# durable copy until run state moves to S3.
# The repo path is ABSOLUTE because this script runs from its installed copy in Application Support, not
# from the repo — `dirname $0/..` resolves to ~/Library/Application Support/ there, which is how the first
# launchd run died looking for scripts/sync-candle-spread-runs.js in the wrong tree. capture-cron.sh
# hardcodes REPO for the same reason.
REPO="/Users/tdriscoll/Documents/surf/optioncalc"
LOG="${TMPDIR:-/tmp}/candle-spread-sync.log"
cd "$REPO" || { echo "$(date '+%F %T') FATAL: cannot cd $REPO" >>"$LOG"; exit 1; }
exec /usr/bin/env node scripts/sync-candle-spread-runs.js >>"$LOG" 2>&1
