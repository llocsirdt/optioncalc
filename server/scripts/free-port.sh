#!/bin/sh
# Pre-`npm run dev` cleanup: free port 3001 and kill any leftover proxy-server dev
# instances (nodemon watchers + their node children), so `npm run dev` starts clean
# instead of crashing with EADDRINUSE when one is already running.
#
# The kill pattern lives in this file (not on the command line), so the running
# script's own command ("sh scripts/free-port.sh") does NOT match "proxy-server-sdk"
# and we never kill ourselves.
PORT=3001

# 1) Kill whatever is actually listening on the port.
for pid in $(lsof -ti tcp:$PORT 2>/dev/null); do
  kill -9 "$pid" 2>/dev/null
done

# 2) Kill any stray nodemon watchers / node children for this server (exclude self + parent).
for pid in $(pgrep -f "proxy-server-sdk" 2>/dev/null); do
  if [ "$pid" != "$$" ] && [ "$pid" != "$PPID" ]; then
    kill -9 "$pid" 2>/dev/null
  fi
done

# Give the OS a moment to release the socket before nodemon binds it.
sleep 0.5
exit 0
