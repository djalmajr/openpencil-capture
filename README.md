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

The toolbar fades while the pointer is over it so content underneath remains selectable. No page data is transmitted: captures stay in the clipboard. To embed images, the page fetches them first; if that fails, the extension fetches them from their own server without cookies. A `<use>` that shows a sprite file has the page fetch that file again, same origin only, as the browser did to draw it.

The picker follows live DOM updates between hover and click, and recovers a selected element after a framework rerender. Capture mode is installed in every accessible frame: entering an iframe activates its local picker and hides the parent's, so selection and capture operate on the iframe's own DOM without stacked toolbars.

During serialization the toolbar collapses to `Capturing selection…` or `Capturing page…`. Its percentage stops below completion until the real work finishes, and reaches `100%` only after the clipboard write is confirmed.

## What becomes what

| Source | OpenPencil layer |
| --- | --- |
| HTML element | `FRAME` with absolute children, keeping the DOM hierarchy |
| `::before`, `::after`, positioned or in the flow (inline, inline-block, block, flex item) | `FRAME` named `Before · Decoration`, `After · Decoration`, with its quoted text |
| List marker (`::marker`) | Its text (`1.`, `iv.`, a `content` string), or the disc, circle, square or disclosure triangle Chromium paints, as a shape |
| Unpainted SVG wrapper | `GROUP` fitted to its children |
| Text | `TEXT`, one layer per visual line, with visible truncation kept as `...`, preformatted spaces, and the font family the browser drew with |
| `<a href>` | Text hyperlink to the absolute target, for `http(s)`, `mailto` and `tel` |
| `path`, `line`, `polyline`, `polygon`, partial circle | `VECTOR` with an editable vector network |
| `rect`, `circle`, `ellipse` | `RECTANGLE`, `ELLIPSE`; a turned one becomes a `VECTOR` |
| SVG `transform` | Applied to the vector network |
| `<use>` of a `<symbol>` or graphic, in the page or in a same-origin file | The referenced graphics, with the styles and `currentColor` they inherit from the `<use>`; a file's own style rules apply |
| Shadow roots, open and (in the extension) closed, and slots | Their rendered content, in place |
| `<iframe>`, same origin or not | Its document, clipped to the frame, over the canvas background. Another origin's document is captured in the frame itself, by the extension's script there or by the CLI's browser |
| Color, including `oklch`, `oklab`, `lab`, `lch` and `color()` spaces | Solid fill |
| CSS linear, radial and conic gradient, SVG linear gradient | Native linear, radial or angular gradient |
| Layered `background` | One fill per layer over the background color; a layer that paints only part of the box, and every layer above it, becomes a rectangle of its own |
| `background-size`, `background-position`, `background-repeat` | Image placed, cropped or tiled where the page shows it |
| Gradient tiled by `background-size` (dot grids, checkerboards) | Repeating image of one tile, drawn at twice its size |
| `repeating-linear-gradient` with sharp stops | Clipped vector stripes |
| `background-clip:text` | The background as the text's fill |
| `<img>`, CSS `url()` background, `<canvas>` | Image fill with the bytes embedded, placed by `object-fit` and `object-position` |
| SVG, AVIF and other images CanvasKit cannot decode | Image fill rasterized at twice the displayed size |
| `grayscale()`, `brightness()` on an image | Editable overlay layers above the image |
| Other color filters on an image | Baked into its pixels |
| Color filters (`grayscale()`, `sepia()`, `saturate()`, `hue-rotate()`, `invert()`, `brightness()`, `contrast()`) on any other element | Applied, in order and in sRGB as Chromium does, to every fill, gradient stop, stroke and shadow it paints; baked into its CSS background images |
| `clip-path` shape (`inset()`, `circle()`, `ellipse()`, `polygon()`, `path()`) or `url()` to a `<clipPath>` | A vector mask over the element |
| `mask-image` gradients and images, or `url()` to a `<mask>` | An alpha (or luminance) mask, its layers placed like backgrounds |
| `filter: blur()`, `drop-shadow()`, `opacity()`; `backdrop-filter: blur()` | Layer blur, drop shadow, layer opacity; background blur |
| `mix-blend-mode` | Fill blend mode |
| `box-shadow`, border, per-side border, radius | Effects, strokes and corners; SVG `stroke-dasharray` keeps its dashes |
| Elliptical corners (`border-radius:50%` on a box that is not square, `10px / 20px`) | A vector of the exact outline holding the background and shadows, and a ring for the border |
| Dashed and dotted borders | Laid out as Chromium does: one line per side with square corners, one loop along the border with rounded ones, gaps fitted to whole dashes, round dots from 3px |

Before serializing, the extension waits for SVG geometry to stabilize so animated charts are not copied mid-transition.

Images and canvas pixels travel inside the clipboard, so pasting needs no network.

### Sensitive values

Values the page masks paste as bullets, both `type=password` fields and anything using `-webkit-text-security`. Nothing the page does not render is read: content under `display:none`, `opacity:0` or `content-visibility:hidden` (`hidden=until-found`), everything in a closed `<details>` but its summary, text under `visibility:hidden`, a hidden frame, `type=hidden` fields, and text or control values moved off the page or clipped out of sight, character by character, by an `overflow` box inside the selection. A frame of another origin gives only what shows through its `<iframe>`, and `clip-path:inset()` hides what it cuts. A sprite file is fetched only for a `<use>` the page draws, over http(s), and used only if it comes back as SVG.

### Known limitations

Limits of the capture model:

- Layout is absolute; Auto Layout is not inferred.
- A pseudo-element in the flow is placed from what it sits next to, the way a first or last child would be. Pseudo-elements of grid items, of right-to-left text and of reversed or wrapping flex lines are left out. `content` from counters, `attr()` or images gives no text. A positioned pseudo-element keeps the translation of its transform, not a rotation or scale.
- List markers follow `list-style-type` and the list's numbering (`start`, `value`, `reversed`); custom counters and `list-style-image` are left out.
- Color filters on CSS background images are baked only by the extension: the CLI keeps the image unfiltered. `filter:url()` and other `backdrop-filter` functions than `blur()` are dropped.
- Masks stack their layers as `mask-composite:add` does, whatever the value. A `<mask>` or `<clipPath>` takes its direct shapes, not `<use>`, `<text>` or nested groups, and not a `<mask>`'s region. Gradients defined inside a sprite file a `<use>` shows are left out.
- A frame of another origin is captured when something can run there: the extension's script, injected in every frame when capture mode opens (a frame that loads later stays empty until it is reopened), or the CLI's browser. A frame that refuses it and, in the extension, one inside a shadow tree stay empty; the capture lists the ones it could not reach in `frames`. A frame of either origin that a transform, an SVG `<foreignObject>`, a motion path or `zoom` scales, turns, mirrors or skews, on it or around it, stays empty too, since what shows of it cannot be worked out; a translation alone is fine.
- `clip-path:inset()`, on an element or a frame, keeps what it cuts away out of the capture; a length it cannot work out cuts everything. Other clip shapes and masks hide content in the design, but the masked layers still hold it.
- Ids are looked up across the whole capture, so a frame and the page that share an id for a gradient, `<clipPath>` or `<mask>` can pick up each other's.
- A gradient that blends outside sRGB (`in oklab`, `oklch` stops) or through a color hint gets stops in between, so it is close but no longer has only the stops written. `lab`, `lch`, `hsl` and `hwb` blend as `oklab`, `oklch` and sRGB. `background-repeat:space` repeats without spacing.
- A border with different colors per side takes one color. A dashed border with rounded corners and sides of different widths keeps the editor's dashes.

When a resource cannot be read, or the clipboard is misused:

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
