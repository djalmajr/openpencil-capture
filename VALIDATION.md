# Validation

Every item ends in PASS, FAIL, NOT RUN or BLOCKED, measured on the final state of the code. There is no typechecker: the project is plain ESM.

## Automated

| Layer | Command | Proves |
| --- | --- | --- |
| Unit | `bun test` | Capture tree, scene node mapping, envelope shape, clipboard write order, image loading, toolbar mark |
| Engine integration | `bun test test/openpencil-engine.test.mjs` | The pinned `@open-pencil/core` parses and pastes the envelope, keeps coordinates, and renders pixels in place |
| Fixture browser | `bun test test/capture-url.test.mjs` | `captureUrl` against a real Chromium |
| Picker | `bun run smoke:picker` | Picker states, Escape, reopen, rerender recovery and progress, on a live shadcn page |
| Iframe | `bun run smoke:iframe`, `bun run smoke:extension-iframe` | Cross-origin iframe capture, with and without the loaded extension |
| Paste, end to end | `bun run smoke:paste` | Loaded extension, real paste event, engine paste, visual comparison (RMSE gate 0.08), and a keyboard paste in the hosted editor |
| Desktop route | `bun run smoke:webkit` (macOS, after `smoke:paste`) | WKWebView, native `paste:`, Tauri `read_text` backed by `NSPasteboard`, hosted editor code |

Not in the suite: Stryker-style mutation runs. The named mutations were executed by hand when the tests were written (stripe phase, half-leading offset, transparent stop hue, copy event order, black toolbar mark).

CI (`.github/workflows/ci.yml`) runs `bun run verify` and `smoke:iframe`. The other smokes stay local: they need ImageMagick, a live third-party page or macOS.

## Manual

Automation cannot reach the installed desktop app here: macOS Accessibility is off for the agent, and the app is single-instance.

1. Load `dist/extension` in Chrome.
2. Capture an element on any page with images.
3. Press `Cmd+V` on the canvas of a new document in the OpenPencil desktop app.
4. Check that the layers are editable and the images show.

## Last run

Date: 2026-11-06. macOS 26.7.1, OpenPencil packages 0.16.0, Playwright Chromium 149.

| Item | Result | Evidence |
| --- | --- | --- |
| `bun test` | PASS | 101 pass, 0 fail |
| Toolbar mark in the loaded extension | PASS | Selection and capturing views, inspected at 2x |
| `bun run build` | PASS | `dist/extension` |
| `smoke:picker` | PASS | Live shadcn page, 50,752 byte envelope |
| `smoke:iframe` | PASS | Cross-origin |
| `smoke:extension-iframe` | PASS | Loaded extension, cross-origin |
| `smoke:paste` | PASS | RMSE 0.0626, 65 layers, 5 of 5 image fills with bytes |
| `smoke:webkit` | PASS | HTML flavor read as empty, one `read_text`, same 65 layers, 5 of 5 image fills with bytes |
| CLI `capture`, `verify`, `convert`, `clipboard` | PASS | One-element fixture |
| Manual paste in the installed desktop app | NOT RUN | Needs a person |
| Chrome writing to the real macOS pasteboard | NOT RUN | Smokes run headless with an isolated clipboard; `smoke:webkit` writes the bytes itself, assuming Chrome's `<meta charset='utf-8'>` prefix |
| Chrome Web Store packaging, Windows, Linux | NOT RUN | Out of scope |

The hosted editor shows `2 font faces are unavailable or substituted` after this paste. A bold text created natively there, with no capture involved, triggers the same warning.
