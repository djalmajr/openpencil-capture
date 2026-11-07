# Validation

Every item ends in PASS, FAIL, NOT RUN or BLOCKED, measured on the final state of the code. There is no typechecker: the project is plain ESM.

## Automated

| Layer | Command | Proves |
| --- | --- | --- |
| Unit | `bun test` | Capture tree, scene node mapping, envelope shape, clipboard write order, image loading, toolbar mark |
| Engine integration | `bun test test/openpencil-engine.test.mjs` | The pinned `@open-pencil/core` parses and pastes the envelope, keeps coordinates, and renders pixels in place |
| Fixture browser | `bun test test/capture-url.test.mjs` | `captureUrl` against a real Chromium |
| Capture in the browser | `bun test test/capture-dom.test.mjs` | In Chromium: nothing unrendered, clipped or off the page is read; colors match the pixels Chromium paints; shadow roots, slots, cross-origin frames, pseudo-elements, preformatted text, font fallback, links, `background-clip:text`, layer order, and the offscreen rasterizer's color filters |
| Visual fidelity | `bun test test/fidelity.test.mjs` | 30 fixtures without text, each rendered by Chromium and, after capture and paste, by the editor; mean difference over 4 × 4 blocks under 1.5%. Gradients of every kind and space, layered and tiled backgrounds, image placement, scroll clipping, percentage radii, shadow DOM, frames, `<use>`, SVG transforms and dashes, pseudo-elements |
| Picker | `bun run smoke:picker` | Picker states, Escape, reopen, rerender recovery and progress, on a live shadcn page |
| Iframe | `bun run smoke:iframe`, `bun run smoke:extension-iframe` | Cross-origin iframe capture, with and without the loaded extension. A hostile page cannot use the extension's fetch through the removed events, and scripted input cannot start a capture. With the loaded extension: a closed shadow root and an SVG inside the card are captured, `Esc` closes every frame, and the toolbar button opens and closes all frames together, including during a success message. Other frames can still hide the toolbar or cancel a capture with `postMessage`; that denies service but exposes no data |
| Paste, end to end | `bun run smoke:paste` | Loaded extension, real paste event, engine paste, visual comparison (RMSE gate 0.08), and a keyboard paste in the hosted editor |
| Desktop route | `bun run smoke:webkit` (macOS, after `smoke:paste`) | WKWebView, native `paste:`, Tauri `read_text` backed by `NSPasteboard`, hosted editor code |

Not in the suite: Stryker-style mutation runs. The named mutations were executed by hand when the tests were written (stripe phase, half-leading offset, transparent stop hue, copy event order, black toolbar mark, omitted cookies, restored page channel, untrusted input accepted, CSS masking ignored; then collapsed content read, per-frame toolbar toggle, display-p3 transfer, `to <side>` drawn top to bottom, mirrored conic, ignored background position, scroll containers not clipping, no interpolation curve, pseudo-elements skipped, closed shadow roots unread, the shadow-root API called on SVG).

CI (`.github/workflows/ci.yml`) runs `bun run verify`, `smoke:iframe` and `smoke:extension-iframe`. The other smokes stay local: they need ImageMagick, a live third-party page or macOS.

## Manual

Automation cannot reach the installed desktop app: macOS Accessibility is off for agents, and the app is single-instance. Run this check when changing the clipboard contract or bumping `@open-pencil/*`.

1. Load `dist/extension` in Chrome.
2. Capture an element on any page with images.
3. Press `Cmd+V` on the canvas of a new document in the OpenPencil desktop app.
4. Check that the layers are editable and the images show.

## Last run

Date: 2026-11-07, at the head of `fix/capture-fidelity`. macOS 26.7.1, OpenPencil packages 0.16.0, Playwright Chromium 149.

| Item | Result | Evidence |
| --- | --- | --- |
| `bun test` | PASS | 166 pass, 0 fail, 7 files plus 2 browser suites |
| `bun run build` | PASS | `dist/extension` |
| `smoke:picker` | PASS | Live shadcn page |
| `smoke:iframe` | PASS | Cross-origin |
| `smoke:extension-iframe` | PASS | Closed shadow root and SVG captured, `Esc` and the button close every frame |
| `smoke:paste` | PASS | RMSE 0.0625, 64 layers, 5 of 5 image fills with bytes |
| `smoke:webkit` | PASS | HTML flavor read as empty, one `read_text`, 5 of 5 image fills with bytes |
| CLI `capture`, `verify`, `convert`, `clipboard` | PASS | One-element fixture with a percentage radius and an `in oklab` gradient |
| Manual paste in the installed desktop app | NOT RUN on this head | Last done by the maintainer on an earlier build; the envelope format did not change |
| Filter baking with the loaded extension on a real page | NOT RUN | The offscreen rasterizer is tested in Chromium and the request path in unit tests, not end to end |
| Chrome Web Store packaging, Windows, Linux | NOT RUN | Out of scope |

The hosted editor shows `2 font faces are unavailable or substituted` after this paste. A bold text created natively there, with no capture involved, triggers the same warning.
