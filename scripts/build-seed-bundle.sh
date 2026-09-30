#!/bin/bash
# Build the one-shot seed bundle that the deploy carries to prod.
#
# The records live on this machine; prod's store was emptied by the 2026-09-29 instance replacement. Rather
# than create a long-lived AWS access key to upload them from here, they ride along in the deploy artifact and
# the instance seeds S3 itself — it already has that write permission (run-archive.selfTest proved it).
# 967 MB of run records gzip to ~82 MB (12x: a chain snapshot per candle per variant is hugely repetitive),
# well inside EB's 512 MB application-version limit.
#
# The bundle is NOT committed — it is a build artifact, and 82 MB in git forever would be a poor trade.
# create-deployment-package.sh includes it automatically when it exists, so:
#
#   bash scripts/build-seed-bundle.sh            # everything (29 dates, ~82 MB)
#   bash scripts/build-seed-bundle.sh --days 10  # just the recent history, much smaller
#   bash scripts/create-deployment-package.sh    # -> zip now carries seed-runs.tgz
#   ... deploy it once, confirm, then remove the bundle and repackage:
#   rm server/seed-runs.tgz && bash scripts/create-deployment-package.sh
set -euo pipefail
cd "$(dirname "$0")/.."
ARCHIVE="candle-spread-archive"
OUT="server/seed-runs.tgz"
DAYS=""
[ "${1:-}" = "--days" ] && DAYS="${2:-}"

[ -d "$ARCHIVE" ] || { echo "no $ARCHIVE directory here"; exit 2; }

if [ -n "$DAYS" ]; then
  # Most recent N trade dates, by the date embedded in each runId.
  DATES=$(ls "$ARCHIVE" | grep -oE '_[0-9]{4}-[0-9]{2}-[0-9]{2}_' | tr -d '_' | sort -u | tail -n "$DAYS")
  echo "including the most recent $DAYS trade date(s):"
  echo "$DATES" | sed 's/^/  /'
  LIST=$(mktemp)
  for d in $DATES; do ls "$ARCHIVE" | grep -- "_${d}_" >> "$LIST" || true; done
  COUNT=$(wc -l < "$LIST" | tr -d ' ')
  tar -czf "$OUT" -C "$ARCHIVE" -T "$LIST"
  rm -f "$LIST"
else
  # Every run record. `_`-prefixed names are internal (summaries, prune status, quarantined files) and must
  # not travel: a summary sidecar shares its record's runId, so shipping one risks a tiny projection landing
  # where the real book belongs.
  COUNT=$(ls "$ARCHIVE" | grep -c '^[^_].*\.json$' || true)
  ( cd "$ARCHIVE" && ls | grep '^[^_].*\.json$' ) > /tmp/.seedlist.$$
  tar -czf "$OUT" -C "$ARCHIVE" -T /tmp/.seedlist.$$
  rm -f /tmp/.seedlist.$$
fi

SIZE=$(( $(wc -c < "$OUT") / 1048576 ))
echo ""
echo "wrote $OUT — $COUNT record(s), ${SIZE} MB compressed"
if [ "$SIZE" -gt 450 ]; then
  echo "WARNING: EB application versions are capped at 512 MB. Use --days to trim this down."
fi
echo "next: bash scripts/create-deployment-package.sh   (it will pick the bundle up automatically)"
