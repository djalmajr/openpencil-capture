# Chrome Web Store listing

What the Store's developer dashboard asks for, ready to paste. The package is the release ZIP (see [extension-release.md](extension-release.md)); the images are in [`store/`](../store), regenerated with `bun run store:assets`.

## Store listing

- **Name:** OpenPencil Capture (from the manifest)
- **Summary:** Copy rendered web elements as editable layers for OpenPencil (from the manifest, 132 characters at most)
- **Category:** Developer Tools
- **Language:** English
- **Icon:** `extension/icons/icon-128.png` (in the package)
- **Screenshots (1280 × 800):** `store/screenshot-1-picker.png`, `store/screenshot-2-result.png`
- **Small promotional tile (440 × 280):** `store/promo-small-440x280.png`
- **Homepage:** https://github.com/djalmajr/openpencil-capture
- **Support:** https://github.com/djalmajr/openpencil-capture/issues

**Description:**

> Pick any element on a web page and paste it into OpenPencil as editable layers: frames that keep the page's structure, real text with the fonts the browser used, vector shapes, gradients, images, shadows, borders, masks and filters.
>
> How it works:
> 1. Click the extension icon. A toolbar appears and the element under the pointer is outlined.
> 2. Click, or press Enter, to capture it. Use the arrow keys to select its parent or child, or Cmd/Ctrl + Enter to capture the whole page.
> 3. Switch to OpenPencil and paste.
>
> What comes along: layout and nesting, text with links, SVG icons and charts as vectors, CSS and SVG gradients, background images placed as on the page, canvases, open and closed shadow DOM, frames of the same site and of other sites, pseudo-elements and list markers, dashed borders, elliptical corners, clip paths, masks and color filters.
>
> Private by design: the capture goes only to your clipboard, never to the developer or anyone else, and only what the page shows enters it: hidden content and masked values such as passwords stay out. To embed images, the extension downloads them again from the servers that host them.
>
> Open source (MIT): https://github.com/djalmajr/openpencil-capture

## Privacy practices

- **Single purpose:** Copy a web element the user picks into the clipboard as editable layers for the OpenPencil design editor.
- **scripting:** Injects the picker into the page and its frames when the user clicks the extension's button, and reads the chosen element's rendered layout and styles to build the layers. Nothing runs on a page before that click.
- **Host permission (all sites):** The pages users capture, and the frames inside them, come from any site. `activeTab` reaches only the top frame's origin, but a capture needs the picker in every frame of the page, including frames of other sites, and needs to download the images a page shows but cannot read (cross-origin, without CORS) from their own servers, without cookies, to embed them in the clipboard.
- **clipboardWrite:** Writes the captured layers to the clipboard, which is how they reach OpenPencil.
- **offscreen:** Writes the clipboard for captures made inside frames, and converts images OpenPencil cannot decode (SVG, AVIF) into PNG, locally.
- **Remote code:** No. All code ships in the package.
- **Data usage:** the form's categories cover data the extension collects, that is, transmits off the device. It transmits none: website content is read locally and goes only to the clipboard; image downloads go to the hosts the page already uses and carry nothing from the capture. So tick no category. If a reviewer asks, the answer is "Website content: used locally only, not collected"; ticking **Website content** with that explanation is the cautious alternative.
- **Certifications:** does not sell or transfer user data to third parties; does not use or transfer it for purposes unrelated to the single purpose; does not use it for creditworthiness or lending.
- **Privacy policy URL:** https://github.com/djalmajr/openpencil-capture/blob/main/PRIVACY.md

## Review notes

- The broad host permission puts the submission through Google's longer review. Narrowing it to `optional_host_permissions`, asked for when a capture meets a frame or image of another site, would shorten it at the cost of a permission prompt mid-capture; the extension asks for it up front today.
- `activeTab` is not requested: the host permission already covers it, and reviewers flag permissions an extension does not need.

## Distribution

Public, all regions, free. Visibility can start as **Unlisted** to test the Store build before going public.
