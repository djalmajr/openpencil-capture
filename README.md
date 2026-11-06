# OpenPencil Capture

Capture rendered web elements and paste them as editable layers directly in [OpenPencil](https://openpencil.dev).

The project contains a browser-side capture library, a Chrome Manifest V3 extension with an element picker, and a deterministic converter and CLI.

## Install

```sh
bun install
bun run build
```

Open `chrome://extensions`, enable developer mode and load `dist/extension` as an unpacked extension. After rebuilding, reload it there before testing.

## Extension interaction

Click the extension icon to enter capture mode. The page gets a floating toolbar and a blue outline around the current target.

- Move the pointer to choose an element.
- Click or press `Enter` to capture it.
- Press `↑` to select its parent.
- Press `↓` to return to the previously selected child, or its first child.
- Press `Cmd + Enter` on macOS or `Ctrl + Enter` elsewhere to capture the whole page.
- Press `Esc` to cancel.

Once the toolbar confirms the copy, switch to OpenPencil and paste. With nothing selected, the capture lands selected at the top-left of the current page.

The toolbar fades while the pointer is over it so content underneath remains selectable. No page data is transmitted: captures stay in the clipboard. To embed images, the page fetches them first; if that fails, the extension fetches them from their own server without cookies.

The picker follows live DOM updates between hover and click, and recovers a selected element after a framework rerender. Capture mode is installed in every accessible frame: entering an iframe activates its local picker and hides the parent's, so selection and capture operate on the iframe's own DOM without stacked toolbars.

During serialization the toolbar collapses to `Capturing selection…` or `Capturing page…`. Its percentage stops below completion until the real work finishes, and reaches `100%` only after the clipboard write is confirmed.

## What becomes what

| Source | OpenPencil layer |
| --- | --- |
| HTML element | `FRAME` with absolute children, keeping the DOM hierarchy |
| Unpainted SVG wrapper | `GROUP` fitted to its children |
| Text | `TEXT`, one layer per visual line, with visible truncation kept as `...` |
| `path`, `line`, `polyline`, `polygon`, partial circle | `VECTOR` with an editable vector network |
| `rect`, `circle`, `ellipse` | `RECTANGLE`, `ELLIPSE` |
| Color, including `oklch`, `oklab`, `lab` | Solid fill |
| CSS and SVG linear gradient | Native linear gradient; transparent gradients layer over the background color |
| `repeating-linear-gradient` with sharp stops | Clipped vector stripes |
| `<img>`, CSS `url()` background, `<canvas>` | Image fill with the bytes embedded |
| SVG, AVIF and other images CanvasKit cannot decode | Image fill rasterized at twice the displayed size |
| `grayscale()`, `brightness()` | Editable overlay layers above the image |
| `mix-blend-mode` | Fill blend mode |
| `box-shadow`, border, per-side border, radius | Effects, strokes and corners |

Before serializing, the extension waits for SVG geometry to stabilize so animated charts are not copied mid-transition.

Images and canvas pixels travel inside the clipboard, so pasting needs no network.

### Known limitations

Limits of the capture model:

- Layout is absolute; Auto Layout is not inferred.
- Pseudo-elements, masks and `transform` on SVG elements are not captured.
- `object-position` and a background color on the `<img>` itself are ignored.
- Filters other than `grayscale()` and `brightness()` are dropped. So are link targets; the underline stays.
- A diagonal SVG `<line>` is always drawn from top-left to bottom-right.
- Text uses the first family in `font-family`, even if the browser fell back to a later one, so its metrics can differ.
- Open shadow roots, SVG `<use>` sprites and iframe content in a whole-page capture come out empty.
- Radial and conic gradients are dropped, and `to <side>` linear gradients render top to bottom. In a layered background, only the first image or gradient survives.
- A percentage `border-radius` is read as pixels, and `overflow:auto` or `scroll` containers do not clip.
- Colors outside `rgb`, `oklch`, `oklab` and `lab` are dropped, and transparent text becomes black.
- `background-repeat`, `background-size` lengths, dashed strokes and `<pre>` whitespace are not preserved.

When a resource cannot be read, or the clipboard is misused:

- Password values paste as bullets, and hidden field values are never read.
- An image behind a cross-origin login cannot be embedded, because the extension fetches without cookies.
- A cross-origin canvas the browser refuses to read becomes a transparent `Canvas · Snapshot unavailable` frame.
- An image neither the page nor the extension can fetch leaves a `· Image unavailable` layer.
- **Pasting the clipboard into a text field inserts the Base64 envelope**, because the plain-text flavor has to carry it (see below).

## Clipboard contract

OpenPencil accepts `<!--(openpencil)BASE64(/openpencil)-->` holding a deflated `openpencil/v1` JSON document with `nodes` and `images`. Getting it through the clipboard takes three decisions, and each one breaks a real paste route if undone:

1. **The `text/html` flavor is only the comment.** The desktop app's WebKit strips comments from HTML another app wrote. With nothing else in the markup, the HTML reads as empty and the app falls through to its plain-text route. Any extra element survives sanitizing and blocks that route. An attribute does not work either: WebKit escapes it to `&lt;!--`, which the parser does not match.
2. **The `text/plain` flavor holds the same envelope.** That is what the desktop route reads.
3. **The copy event writes first,** because it stores the HTML verbatim. `navigator.clipboard.write` reserializes it, appending `<html><head></head><body></body></html>` after the comment, so it is only the fallback.

## CLI

```sh
bun bin/openpencil-capture.mjs capture --url <url> --selector <selector> --output card.capture.json
bun bin/openpencil-capture.mjs verify card.capture.json
bun bin/openpencil-capture.mjs convert card.capture.json card.capture-tree.json
bun bin/openpencil-capture.mjs clipboard card.capture.json card.envelope.txt
```

`clipboard` writes the envelope to a file, fetching images over the network. An SVG image has no rasterizer outside the extension, so it ends up as `· Image unavailable` here.

## Development

```sh
bun run verify                  # tests and build, also run by CI
bun run smoke:picker            # picker states against a live shadcn page
bun run smoke:iframe            # cross-origin iframe picker, also run by CI
bun run smoke:extension-iframe  # the loaded extension in a cross-origin iframe
bun run smoke:paste             # extension to clipboard to engine and hosted editor, with a visual comparison
bun run smoke:webkit            # macOS only, after smoke:paste: the desktop paste route in a WKWebView
```

`smoke:paste` writes its evidence to `artifacts/smoke-paste`. Set `OPENPENCIL_CAPTURE_EDITOR_URL=` to skip the hosted editor. See [`VALIDATION.md`](VALIDATION.md) for what each layer proves.

The tests paste into the real engine, so `@open-pencil/*` is pinned to one exact version. Bump it deliberately and run the smokes: the clipboard format is an internal contract of OpenPencil, not a published API.

## Visual comparison

```sh
bun run capture:source -- <url> <selector> artifacts/source.png
bun run compare:visual -- artifacts/source.png artifacts/openpencil.png artifacts/comparison --require-same-size --max-rmse 0.10
```

The comparison writes `report.json`, `report.html`, `side-by-side.png` and `diff.png`, and exits unsuccessfully if a declared gate fails.

## Icons

The icons derive from the official OpenPencil app icon and mark, which are MIT licensed: see [`assets/brand/LICENSE`](assets/brand/LICENSE). The toolbar mark is rendered from `assets/brand/mark-micro.svg` with `bun run render:mark`, through a browser, because ImageMagick paints this artwork black.

## License

[MIT](LICENSE).
