#!/bin/bash
# Mirror prod's candle-spread runs into the local archive. Driven by the LaunchAgent in
# scripts/com.optioncalc.run-sync.plist, which fires after the close each weekday.
#
# WHY THIS EXISTS. The sync script was written but never scheduled, so it only ran when someone
# remembered. It last ran around 2026-09-08. When an EB instance replacement wiped /var/optioncalc-data
# at 00:12Z on 2026-09-16, the runs for 09-09 through 09-14 went with it -- they had never been mirrored
# anywhere, and they are gone. The store lives on instance-local disk, so the local archive is the ONLY
# durable copy until run state moves to S3.
cd "$(dirname "$0")/.." || exit 1
exec /usr/bin/env node scripts/sync-candle-spread-runs.js >> "${TMPDIR:-/tmp}/candle-spread-sync.log" 2>&1
