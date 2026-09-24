#!/bin/bash
# Headless checks for both hosts. Uses Playwright's Chrome for Testing for the extension
# (branded Google Chrome >=137 ignores --load-extension, so it cannot be used here).
set -uo pipefail
cd "$(dirname "$0")/.."
OUT="${KIROCREW_SCRATCH:-${TMPDIR:-/tmp}}/mdreader-tests"; mkdir -p "$OUT"
CFT=$(ls -d "$HOME"/Library/Caches/ms-playwright/chromium-*/chrome-mac-arm64/"Google Chrome for Testing.app"/Contents/MacOS/"Google Chrome for Testing" 2>/dev/null | tail -1)
python3 -m http.server 8477 --bind 127.0.0.1 --directory "$PWD" >/dev/null 2>&1 & SRV=$!; sleep 1
echo "== extension"; MDR_CHROME="$CFT" node test/ext-test.mjs http://127.0.0.1:8477/sample.md "$OUT/ext" | grep -E '"(mounted|tables|filesHidden|editRendered|pinchOk|buttonsOk|widthOk|filterOk)"|EXC'; E=${PIPESTATUS[0]}
kill $SRV 2>/dev/null
echo "== app"; node test/app-test.mjs "$OUT/app" | grep -E '"(mounted|defaultTheme|stillMounted|outlineToggleOk|tabsOk|newTabOk|dragOk|pathLinksOk|imageOk|pinchAnchorOk|windows|secondFileUntouched|filesPanelVisible|savedToDisk|dirtyAfterSave|reloadedFromDisk)"|EXC'; A=${PIPESTATUS[0]}
echo "== session"; node test/session-test.mjs "$OUT/session" | grep -E '"(sessionOk|restored|restoredPlusArg)"'; S=${PIPESTATUS[0]}
echo "ext rc=$E  app rc=$A  session rc=$S  screenshots: $OUT"; [ $E -eq 0 ] && [ $A -eq 0 ] && [ $S -eq 0 ]
