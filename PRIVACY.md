# Privacy policy

OpenPencil Capture is a browser extension that copies a web element you choose, as you see it, into your clipboard as layers for OpenPencil. This policy covers the extension and the command-line tool in this repository.

## What it collects

Nothing. The extension has no server, account, analytics, telemetry or advertising. It does not store browsing history, and it keeps no data after a capture ends.

## What it reads, and when

Only after you click the toolbar button, and then pick an element or press Cmd/Ctrl + Enter to take the whole page, the extension walks the page to find what that element shows on screen: its layout, styles, text, images and the frames inside it. Only what the page renders enters the capture. Hidden content, values the page masks (such as passwords), and content clipped out of view stay out.

## Where that goes

The capture goes to your clipboard, on your device, and is never sent to the developer or anyone else. You decide where to paste it.

To embed the images an element shows, the extension downloads them again: first as the page itself would, and if the page cannot, from the image's own server without cookies. A sprite file that an SVG on the page draws from is fetched the same way, from the page's own site. These requests go only to the servers that already host those images and files, which see an ordinary download (your address and browser, and, for the page's own site, its cookies, as when the page loaded them), and carry nothing from the capture.

## Permissions

- **scripting, with access to all sites:** to show the picker in the tab where you clicked the button and in every frame of that page, which can come from any site, only when you start a capture; and to download images a page cannot read from their own servers, without cookies.
- **clipboardWrite, offscreen:** to write the capture to the clipboard, and to convert images the editor cannot read (such as SVG) into PNG on your device.

The extension's mark, shown in its toolbar, is loaded from a per-session address, so pages cannot use it to tell whether the extension is installed.

## Changes

Changes to this policy are published in this file, in the extension's public repository: <https://github.com/djalmajr/openpencil-capture/blob/main/PRIVACY.md>.

## Contact

Open an issue at <https://github.com/djalmajr/openpencil-capture/issues>.
