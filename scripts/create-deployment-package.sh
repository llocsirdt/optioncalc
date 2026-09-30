#!/bin/bash
# Create deployment ZIP for Elastic Beanstalk.
# Packages the ACTUAL working tree of server/ (including any uncommitted
# local edits — run `git status` first if you only want committed code),
# stamped with a build-info.json recording exactly what was packaged so
# GET /health on the deployed server can prove what's actually running
# instead of having to infer it from behavior.
set -euo pipefail

cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"
SERVER_DIR="$REPO_ROOT/server"
OUTPUT_ZIP="$REPO_ROOT/schwab-proxy-deploy.zip"

# PREFLIGHT — a deploy is the moment the live engine starts running whatever the baselines claim to
# describe, so this is where the two must be proven to agree. Blocks on an ACTIVE parity divergence (a
# field a live run sets but only one engine implements) or on two variants being behaviourally identical.
# Override with SKIP_PREFLIGHT=1 for an emergency deploy, deliberately and knowing what it hides.
if [ "${SKIP_PREFLIGHT:-0}" != "1" ]; then
  echo "Running engine preflight..."
  if ! node "$REPO_ROOT/scripts/candle-spread/preflight.js"; then
    echo ""
    echo "DEPLOY BLOCKED: the live engine and the backtest disagree on a field a live run sets."
    echo "Reconcile them, or re-run with SKIP_PREFLIGHT=1 if you accept shipping without that guarantee."
    exit 1
  fi
else
  echo "!! SKIP_PREFLIGHT=1 — packaging WITHOUT the live/backtest parity check."
fi

echo "Writing server/build-info.json..."
GIT_COMMIT="$(git rev-parse HEAD)"
GIT_COMMIT_SHORT="$(git rev-parse --short HEAD)"
GIT_DIRTY="clean"
if [ -n "$(git status --porcelain)" ]; then
  GIT_DIRTY="dirty (uncommitted changes present at package time)"
fi
PACKAGED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

cat > "$SERVER_DIR/build-info.json" << EOF
{
  "gitCommit": "$GIT_COMMIT",
  "gitCommitShort": "$GIT_COMMIT_SHORT",
  "gitStatus": "$GIT_DIRTY",
  "packagedAt": "$PACKAGED_AT"
}
EOF
cat "$SERVER_DIR/build-info.json"

echo ""
echo "Creating $OUTPUT_ZIP from the current server/ working tree..."
rm -f "$OUTPUT_ZIP"
cd "$SERVER_DIR"
zip -r "$OUTPUT_ZIP" . \
  -x "node_modules/*" \
  -x "*.DS_Store" \
  -x "src/persistence/chain-cache/*" \
  -x "src/persistence/server-state.json" \
  -x "src/persistence/server-state.backup.json" \
  -x "src/persistence/positions.json" \
  -x "src/persistence/positions-*.json" \
  -x "src/persistence/candle-spread-runs/*" \
  > /dev/null

echo ""
# AN 82 MB DEPLOY SHOULD NOT BE A SURPRISE. seed-runs.tgz rides along automatically when present (see
# scripts/build-seed-bundle.sh), so say so loudly with the size, and say how to stop shipping it. Left in
# place it is harmless — the seeder is one-shot per bundle — but every deploy would carry it for nothing.
if [ -f "$SERVER_DIR/seed-runs.tgz" ]; then
  SEED_MB=$(( $(wc -c < "$SERVER_DIR/seed-runs.tgz") / 1048576 ))
  echo "*** THIS PACKAGE CARRIES A SEED BUNDLE: seed-runs.tgz, ${SEED_MB} MB ***"
  echo "    On boot the instance unpacks it to the run store and uploads the records to S3 (one-shot,"
  echo "    never overwrites). Deploy it ONCE, confirm via /health -> candleRunArchive, then:"
  echo "      rm server/seed-runs.tgz && bash scripts/create-deployment-package.sh"
  echo "    to go back to a small package."
  echo ""
fi
echo "Done: $OUTPUT_ZIP"
unzip -l "$OUTPUT_ZIP"

echo ""
echo "After deploying, verify with:"
echo "  curl https://your-eb-url/health"
echo "and confirm the \"build\" field matches gitCommit=$GIT_COMMIT_SHORT above."
