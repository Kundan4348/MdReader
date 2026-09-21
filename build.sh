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
rsync -a --delete app/dist/mac-arm64/MdReader.app/ /Applications/MdReader.app/
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f /Applications/MdReader.app
echo
echo "App:       /Applications/MdReader.app  (built at app/dist/mac-arm64/MdReader.app)"
echo "Extension: $(pwd)/extension  (load unpacked at chrome://extensions)"
