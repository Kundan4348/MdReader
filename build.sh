#!/bin/bash
# Sync the shared core into both hosts and build the desktop app.
set -euo pipefail
cd "$(dirname "$0")"
rsync -a --delete --exclude dev.html core/ extension/core/
rsync -a --delete --exclude dev.html core/ app/renderer/core/
( cd app && [ -d node_modules ] || npm install --no-fund --no-audit )
( cd app && npx electron-builder --mac --arm64 --dir )
[ "${SKIP_TESTS:-}" ] || ./test/run.sh
# Install into /Applications (the copy LaunchServices treats as THE app) and refresh its registration.
# A running instance must be quit first: Electron keeps the asar's header (byte offsets) from launch, so replacing
# app.asar underneath it makes the next window load garbage from the new file at the old offsets (index.html came
# back as a slice of sections.css). Quit via AppleScript so the unsaved-changes prompt still applies; give up rather
# than install under it. Tabs come back on relaunch through the saved session.
WAS_RUNNING=
if pgrep -xq MdReader; then
  WAS_RUNNING=1
  osascript -e 'tell application "MdReader" to quit' >/dev/null 2>&1 || true
  for _ in $(seq 1 40); do pgrep -xq MdReader || break; sleep 0.5; done
  if pgrep -xq MdReader; then
    echo "MdReader is still running (unsaved changes prompt?) -- not installing over a live instance." >&2
    echo "Built at app/dist/mac-arm64/MdReader.app; quit MdReader and re-run ./build.sh to install." >&2
    exit 1
  fi
fi
rsync -a --delete app/dist/mac-arm64/MdReader.app/ /Applications/MdReader.app/
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f /Applications/MdReader.app
[ "$WAS_RUNNING" ] && open -a /Applications/MdReader.app && echo "Relaunched MdReader (tabs restored from the saved session)."
echo
echo "App:       /Applications/MdReader.app  (built at app/dist/mac-arm64/MdReader.app)"
echo "Extension: $(pwd)/extension  (load unpacked at chrome://extensions)"
