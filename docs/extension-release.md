# Extension releases

Releases are tagged `ext-vX.Y.Z`. Each one is a GitHub Release with one ZIP, which serves two uses: upload it to the Chrome Web Store as it is, or extract it and load the folder with Chrome's **Load unpacked**. The packaged manifest has no `key`, so the Store assigns the extension ID.

## Prepare a release

1. Set the same version in `extension/manifest.json` and `package.json`.
2. Add `extension/releases/X.Y.Z.md`.
3. Run:

   ```sh
   bun run verify
   bun run smoke:extension-iframe
   bun run package:ext -- --expected-version X.Y.Z
   ```

`package:ext` rebuilds the extension and writes `artifacts/openpencil-capture-X.Y.Z.zip`. It fails when the versions differ, when a file the manifest or the code loads (the service worker, icons, `content.js`, `offscreen.html` and its script) is missing, when the archive would ship a source map, a test, a hidden file or a manifest `key`, or when the archive does not read back as the same files. The same build always packs to the same bytes.

## Publish

After the release change reaches `main`:

```sh
git tag -a ext-vX.Y.Z -m ext-vX.Y.Z
git push origin ext-vX.Y.Z
```

The `Release extension` workflow checks that the tag, the manifest and the package agree and that the notes exist, runs the tests and the loaded-extension smoke, packages the ZIP with its SHA-256, and creates **OpenPencil Capture X.Y.Z** with the notes.

Every push to `main` also uploads the ZIP as the `openpencil-capture-extension` artifact of its CI run, for trying a build before releasing it.

## Chrome Web Store

The GitHub Release and the Store are separate. To submit, upload the release ZIP in the developer dashboard and fill the listing from [chrome-web-store.md](chrome-web-store.md); the review is Google's.

## Verify the artifact

```sh
unzip -t artifacts/openpencil-capture-X.Y.Z.zip
unzip -Z1 artifacts/openpencil-capture-X.Y.Z.zip
unzip -p artifacts/openpencil-capture-X.Y.Z.zip manifest.json
shasum -a 256 artifacts/openpencil-capture-X.Y.Z.zip
```
