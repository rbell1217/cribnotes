#!/bin/bash
# CribNotes one-click launcher (macOS)
# Double-click this file in Finder to start a local server and open the app.

set -e

cd "$(dirname "$0")"

PORT=8765

# Try Python 3 first, then Python, then fall back to npx http-server.
if command -v python3 >/dev/null 2>&1; then
  CMD=(python3 -m http.server "$PORT")
elif command -v python >/dev/null 2>&1; then
  CMD=(python -m http.server "$PORT")
elif command -v npx >/dev/null 2>&1; then
  CMD=(npx --yes http-server -p "$PORT" -c-1)
else
  echo "ERROR: Need Python or Node installed to run a local server."
  echo "Install Python from https://www.python.org or Node from https://nodejs.org"
  read -n 1 -s -r -p "Press any key to close..."
  exit 1
fi

echo "============================================="
echo "  CribNotes is starting at http://localhost:$PORT"
echo "  Leave this Terminal window open while you use the app."
echo "  Close this window or press Ctrl-C to stop the server."
echo "============================================="
echo ""

# Open the browser after a short delay so the server has time to bind.
( sleep 1 && open "http://localhost:$PORT" ) &

exec "${CMD[@]}"
