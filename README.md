# MdReader

A calm, beautiful Markdown reader and editor for macOS, with a matching Chrome extension.
Same rendering core in both, so a `.md` looks identical on disk and in the browser.

- Four themes: **Mono** (default), Paper, Studio, Sections
- Tables done right: numeric columns auto-detected and right-aligned in tabular digits, quiet small-caps headers, tinted total rows, inline code as accent chips
- VS Code-style tabs: every open (Finder, ⌘O, file tree, links) lands in the same window
- Edit in place and save back to the same file (⌘E toggle, ⌘S save); external changes reload
- Auto-zoom for large displays plus manual text size (⌘+ / ⌘−) and reading-width modes (⌘⇧W)
- Files tree and outline panels (`☰` / `≡`)

## Layout

| Path | What |
|---|---|
| `core/` | Shared renderer: `md.js` (marked + table smarts + section splitting), `shell.js`/`shell.css` (tabs, panels, zoom), `themes/` |
| `app/` | Electron desktop app (`main.js`, `preload.js`, `renderer/`) |
| `extension/` | Chrome extension (MV3) rendering `.md` pages and a viewer for local files |
| `mockups/` | The three original design mockups |
| `test/` | Headless DevTools-protocol tests for the extension and the app |

`extension/core/` and `app/renderer/core/` are synced copies of `core/` (see `build.sh`).

## Build

```bash
./build.sh          # sync core, build app/dist/mac-arm64/MdReader.app, run tests, install to /Applications
SKIP_TESTS=1 ./build.sh
```

Requires Node 20+. The tests need Playwright's Chrome for Testing (`npx playwright install chromium`);
branded Google Chrome silently ignores `--load-extension`.

## Chrome extension

`chrome://extensions` → Developer mode → Load unpacked → `extension/`, then enable
"Allow access to file URLs" so local `.md` files render too.

## License

MIT
