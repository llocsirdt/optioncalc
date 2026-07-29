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
  > /dev/null

echo ""
echo "Done: $OUTPUT_ZIP"
unzip -l "$OUTPUT_ZIP"

echo ""
echo "After deploying, verify with:"
echo "  curl https://your-eb-url/health"
echo "and confirm the \"build\" field matches gitCommit=$GIT_COMMIT_SHORT above."
