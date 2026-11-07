# Validation

Every item ends in PASS, FAIL, NOT RUN or BLOCKED, measured on the final state of the code. There is no typechecker: the project is plain ESM.

## Automated

| Layer | Command | Proves |
| --- | --- | --- |
| Unit | `bun test` | Capture tree, scene node mapping, envelope shape, clipboard write order, image loading, toolbar mark |
| Engine integration | `bun test test/openpencil-engine.test.mjs` | The pinned `@open-pencil/core` parses and pastes the envelope, keeps coordinates, and renders pixels in place |
| Fixture browser | `bun test test/capture-url.test.mjs` | `captureUrl` against a real Chromium |
| Capture in the browser | `bun test test/capture-dom.test.mjs` | In Chromium: nothing unrendered, clipped (character by character, including by the element's own overflow) or off the page is read, nor anything in a hidden frame, a closed `<details>`, or a frame of another origin beyond what shows of it; colors match the pixels Chromium paints; shadow roots, slots, frames of another origin captured in their own document, pseudo-elements in the flow against a real `<span>` in their place, list markers against their text or shape drawn by Chromium where the capture puts them, `<use>` of a same-origin file and never of another origin, preformatted text, font fallback, links, `background-clip:text`, layer order, and the offscreen rasterizer's color filters |
| Visual fidelity | `bun test test/fidelity.test.mjs` | 60 fixtures without text, each rendered by Chromium and, after capture and paste, by the editor; mean difference over 4 × 4 blocks under 1.5%. Gradients of every kind and space, layered and tiled backgrounds, image placement, scroll clipping, percentage and elliptical radii, dashed and dotted borders square and rounded, color filters, clip paths and masks (shapes, `<clipPath>`, `<mask>`, gradients), shadow DOM, frames of the same and another origin, `<use>` in the page and in another file, SVG transforms and dashes, pseudo-elements |
| Picker | `bun run smoke:picker` | Picker states, Escape, reopen, rerender recovery and progress, on a live shadcn page |
| Iframe | `bun run smoke:iframe`, `bun run smoke:extension-iframe` | Cross-origin iframe capture, with and without the loaded extension. A hostile page cannot use the extension's fetch through the removed events, and scripted input cannot start a capture. With the loaded extension: a closed shadow root and an SVG inside the card are captured, a capture of the page around the frame of another origin takes its content and not the picker's own toolbar, `Esc` closes every frame, and the toolbar button opens and closes all frames together, including during a success message. Other frames can still hide the toolbar or cancel a capture with `postMessage`; that denies service but exposes no data |
| Paste, end to end | `bun run smoke:paste` | Loaded extension, real paste event, engine paste, visual comparison (RMSE gate 0.08), and a keyboard paste in the hosted editor |
| Desktop route | `bun run smoke:webkit` (macOS, after `smoke:paste`) | WKWebView, native `paste:`, Tauri `read_text` backed by `NSPasteboard`, hosted editor code |

Not in the suite: Stryker-style mutation runs. The named mutations were executed by hand when the tests were written (stripe phase, half-leading offset, transparent stop hue, copy event order, black toolbar mark, omitted cookies, restored page channel, untrusted input accepted, CSS masking ignored; then collapsed content read, per-frame toolbar toggle, display-p3 transfer, `to <side>` drawn top to bottom, mirrored conic, ignored background position, scroll containers not clipping, no interpolation curve, pseudo-elements skipped, closed shadow roots unread, the shadow-root API called on SVG; and, after review, the reviewed capture code against direct text in a closed `<details>`, a hidden frame, an element's own overflow, pseudo-elements of skipped content, nested `display:contents`, and fonts declared in a frame or by `unicode-range`; then, closing the known limitations, color filters not applied, a shadow filtered by functions before it, an image filtered twice, masks and clip paths ignored, `<clipPath>` and `<mask>` references ignored, elliptical corners made circular, side and loop dashes not fitted, the loop measured without Chromium's half pixel, flex `gap` and `vertical-align:middle` ignored for pseudo-elements, leading spaces in their text, Chromium's symbol marker offset, external `<use>` files not read or their style rules ignored, `<use>` fetched from another origin, frames of another origin not merged, a frame's viewport or the page's clip around it ignored, and the picker's toolbar captured; and, after review, a side too short to dash, text straight in a shadow root, a filter recoloring a mask, an ancestor's filter kept from a drop shadow, an elliptical shadow under a clipping frame, `clip-path:inset()` content read, a transformed frame of another origin, and sprite files fetched for a hidden `<use>` or used when not SVG; then a frame turned or mirrored at its own size, a frame's own inset ignored, `calc()` in an inset, fixed descendants and `content-box` insets).

CI (`.github/workflows/ci.yml`) runs `bun run verify`, `smoke:iframe` and `smoke:extension-iframe`. The other smokes stay local: they need ImageMagick, a live third-party page or macOS.

## Manual

Automation cannot reach the installed desktop app: macOS Accessibility is off for agents, and the app is single-instance. Run this check when changing the clipboard contract or bumping `@open-pencil/*`.

1. Load `dist/extension` in Chrome.
2. Capture an element on any page with images.
3. Press `Cmd+V` on the canvas of a new document in the OpenPencil desktop app.
4. Check that the layers are editable and the images show.

## Last run

Date: 2026-11-07, at the head of `fix/remaining-gaps`. macOS 26.7.1, OpenPencil packages 0.16.0, Playwright Chromium 149.

| Item | Result | Evidence |
| --- | --- | --- |
| `bun test` | PASS | 255 pass, 0 fail, 8 files |
| `bun run build` | PASS | `dist/extension` |
| `smoke:picker` | PASS | Live shadcn page |
| `smoke:iframe` | PASS | Cross-origin |
| `smoke:extension-iframe` | PASS | Closed shadow root and SVG captured; the page capture takes the frame of another origin and not the toolbar; `Esc` and the button close every frame |
| `smoke:paste` | PASS | RMSE 0.0625, 64 layers, 5 of 5 image fills with bytes |
| `smoke:webkit` | PASS | HTML flavor read as empty, one `read_text`, 5 of 5 image fills with bytes |
| CLI `capture` | PASS | `captureUrl` against Chromium in `capture-url.test.mjs`; frames of another origin through the same `captureTarget` the tests use |
| Manual paste in the installed desktop app | NOT RUN on this head | Last done by the maintainer on an earlier build; the envelope format did not change, and masks, vectors and shapes paste through the same route the engine test covers |
| Filter baking with the loaded extension on a real page | NOT RUN | The offscreen rasterizer is tested in Chromium and the request path in unit tests, not end to end |
| Chrome Web Store packaging, Windows, Linux | NOT RUN | Out of scope |

The hosted editor shows `2 font faces are unavailable or substituted` after this paste. A bold text created natively there, with no capture involved, triggers the same warning.
