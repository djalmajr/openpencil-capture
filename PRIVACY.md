# Privacy policy

OpenPencil Capture is a browser extension that copies a web element you choose, as you see it, into your clipboard as layers for OpenPencil. This policy covers the extension and the command-line tool in this repository.

## What it collects

Nothing. The extension has no server, account, analytics, telemetry or advertising. It does not store browsing history, and it keeps no data after a capture ends.

## What it reads, and when

Only when you click the toolbar button and pick an element, or press the shortcut to capture the page, the extension reads what that element shows on screen: its layout, styles, text, images and the frames inside it. It reads nothing the page does not render. Hidden content, values the page masks (such as passwords), and content clipped out of view stay out.

## Where that goes

The capture goes to your clipboard, on your device, and nowhere else. You decide where to paste it.

To embed the images an element shows, the extension downloads them again: first as the page itself would, and if the page cannot, from the image's own server without cookies. A sprite file that an SVG on the page draws from is fetched the same way, from the page's own site. These requests go only to the servers that already host those images, and carry nothing from the capture.

## Permissions

- **activeTab, scripting:** to show the picker in the tab you clicked, and in the frames of that page, only when you start a capture.
- **Access to all sites:** pages and the frames inside them come from any site, and the picker must run in each frame you capture.
- **clipboardWrite, offscreen:** to write the capture to the clipboard, and to convert images the editor cannot read (such as SVG) into PNG on your device.

## Changes

Changes to this policy are published in this file, in the extension's public repository: <https://github.com/djalmajr/openpencil-capture/blob/main/PRIVACY.md>.

## Contact

Open an issue at <https://github.com/djalmajr/openpencil-capture/issues>.
