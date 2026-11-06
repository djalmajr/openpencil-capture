# Validation

Every item ends in PASS, FAIL, NOT RUN or BLOCKED, measured on the final state of the code. There is no typechecker: the project is plain ESM.

## Automated

| Layer | Command | Proves |
| --- | --- | --- |
| Unit | `bun test` | Capture tree, scene node mapping, envelope shape, clipboard write order, image loading, toolbar mark |
| Engine integration | `bun test test/openpencil-engine.test.mjs` | The pinned `@open-pencil/core` parses and pastes the envelope, keeps coordinates, and renders pixels in place |
| Fixture browser | `bun test test/capture-url.test.mjs` | `captureUrl` against a real Chromium |
| Picker | `bun run smoke:picker` | Picker states, Escape, reopen, rerender recovery and progress, on a live shadcn page |
| Iframe | `bun run smoke:iframe`, `bun run smoke:extension-iframe` | Cross-origin iframe capture, with and without the loaded extension. A hostile page cannot use the extension's fetch through the removed events, and scripted input cannot start a capture. Other frames can still hide the toolbar or cancel a capture with `postMessage`; that denies service but exposes no data |
| Paste, end to end | `bun run smoke:paste` | Loaded extension, real paste event, engine paste, visual comparison (RMSE gate 0.08), and a keyboard paste in the hosted editor |
| Desktop route | `bun run smoke:webkit` (macOS, after `smoke:paste`) | WKWebView, native `paste:`, Tauri `read_text` backed by `NSPasteboard`, hosted editor code |

Not in the suite: Stryker-style mutation runs. The named mutations were executed by hand when the tests were written (stripe phase, half-leading offset, transparent stop hue, copy event order, black toolbar mark, omitted cookies, restored page channel, untrusted input accepted, CSS masking ignored).

CI (`.github/workflows/ci.yml`) runs `bun run verify`, `smoke:iframe` and `smoke:extension-iframe`. The other smokes stay local: they need ImageMagick, a live third-party page or macOS.

## Manual

Automation cannot reach the installed desktop app: macOS Accessibility is off for agents, and the app is single-instance. Run this check when changing the clipboard contract or bumping `@open-pencil/*`.

1. Load `dist/extension` in Chrome.
2. Capture an element on any page with images.
3. Press `Cmd+V` on the canvas of a new document in the OpenPencil desktop app.
4. Check that the layers are editable and the images show.

## Last run

Date: 2026-11-06. macOS 26.7.1, OpenPencil packages 0.16.0, Playwright Chromium 149.

| Item | Result | Evidence |
| --- | --- | --- |
| `bun test` | PASS | 108 pass, 0 fail |
| Toolbar mark in the loaded extension | PASS | Selection and capturing views, inspected at 2x |
| `bun run build` | PASS | `dist/extension` |
| `smoke:picker` | PASS | Live shadcn page, 50,752 byte envelope |
| `smoke:iframe` | PASS | Cross-origin |
| `smoke:extension-iframe` | PASS | Loaded extension, cross-origin |
| `smoke:paste` | PASS | RMSE 0.0626, 65 layers, 5 of 5 image fills with bytes |
| `smoke:webkit` | PASS | HTML flavor read as empty, one `read_text`, same 65 layers, 5 of 5 image fills with bytes |
| CLI `capture`, `verify`, `convert`, `clipboard` | PASS | One-element fixture |
| Manual paste in the installed desktop app | PASS on the previous build | Done by the maintainer before capture moved to the isolated world; the envelope did not change |
| Chrome writing to the real macOS pasteboard | PASS on the previous build | Exercised by the same manual paste |
| Chrome Web Store packaging, Windows, Linux | NOT RUN | Out of scope |

The hosted editor shows `2 font faces are unavailable or substituted` after this paste. A bold text created natively there, with no capture involved, triggers the same warning.
