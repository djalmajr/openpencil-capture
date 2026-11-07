import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { packageExtension, parseOptions, requiredEntries } from "../scripts/package-extension.mjs";

const MANIFEST = {
  manifest_version:3, name:"Fixture", version:"1.2.3",
  background:{service_worker:"background.js"},
  icons:{128:"icons/icon-128.png"}, action:{default_icon:{16:"icons/icon-16.png"}},
  web_accessible_resources:[{resources:["icons/mark.png"], matches:["<all_urls>"]}],
};
const FILES = {
  "background.js":`chrome.scripting.executeScript({target:{tabId}, files:["content.js"]}); const page = "offscreen.html";`,
  "content.js":"// content", "offscreen.html":`<script type="module" src="offscreen.js"></script>`, "offscreen.js":"// offscreen",
  "icons/icon-128.png":"png", "icons/icon-16.png":"png", "icons/mark.png":"png",
};

// A repository with a built extension: `change` edits the manifest, `skip` leaves files out.
function fixture({change = {}, skip = [], extra = {}, packageVersion = "1.2.3"} = {}) {
  const root = mkdtempSync(join(tmpdir(), "openpencil-package-"));
  const manifest = {...MANIFEST, ...change};
  mkdirSync(join(root, "extension"), {recursive:true});
  writeFileSync(join(root, "extension/manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(root, "package.json"), JSON.stringify({version:packageVersion}));
  for (const [name, body] of Object.entries({...FILES, ...extra, "manifest.json":JSON.stringify(manifest)})) {
    if (skip.includes(name)) continue;
    mkdirSync(join(root, "dist/extension", name, ".."), {recursive:true});
    writeFileSync(join(root, "dist/extension", name), body);
  }
  return root;
}

const pack = (root, options = {}) => {
  try { return packageExtension({rootDirectory:root, build:false, ...options}); } finally { rmSync(root, {recursive:true, force:true}); }
};

describe("the extension package", () => {
  test("holds the built extension with its manifest at the root, the same bytes each time", () => {
    const first = pack(fixture(), {output:"out.zip"});
    const second = pack(fixture(), {output:"out.zip"});
    expect(first.entries).toEqual(["background.js", "content.js", "icons/icon-128.png", "icons/icon-16.png", "icons/mark.png", "manifest.json", "offscreen.html", "offscreen.js"]);
    expect(first.sha256).toBe(second.sha256);
  });

  test("writes a ZIP Chrome can read back", () => {
    const root = fixture();
    try {
      const {outputPath} = packageExtension({rootDirectory:root, build:false});
      expect(outputPath.endsWith("artifacts/openpencil-capture-1.2.3.zip")).toBe(true);
      const bytes = readFileSync(outputPath);
      // Each entry is dated 2026-01-01 whatever the build time, in its DOS date field.
      expect(bytes.readUInt16LE(12)).toBe(((2026 - 1980) << 9) | (1 << 5) | 1);
      const files = unzipSync(bytes);
      expect(JSON.parse(new TextDecoder().decode(files["manifest.json"])).version).toBe("1.2.3");
    } finally {
      rmSync(root, {recursive:true, force:true});
    }
  });

  test("refuses mismatched versions, or a version the release did not ask for", () => {
    expect(() => pack(fixture({packageVersion:"1.2.4"}))).toThrow("version mismatch");
    expect(() => pack(fixture(), {expectedVersion:"1.2.4"})).toThrow("expected version 1.2.4");
  });

  test("refuses a file the extension loads but the archive lacks", () => {
    expect(() => pack(fixture({skip:["content.js"]}))).toThrow("missing from the archive: content.js");
    expect(() => pack(fixture({skip:["offscreen.js"]}))).toThrow("missing from the archive: offscreen.js");
    expect(() => pack(fixture({skip:["icons/mark.png"]}))).toThrow("icons/mark.png");
  });

  test("refuses source maps, tests, hidden files and a manifest key", () => {
    expect(() => pack(fixture({extra:{"content.js.map":"{}"}}))).toThrow("not a runtime file: content.js.map");
    expect(() => pack(fixture({extra:{".DS_Store":""}}))).toThrow("not a runtime file: .DS_Store");
    expect(() => pack(fixture({change:{key:"abc"}}))).toThrow("manifest.key");
  });

  test("finds what the real service worker injects and opens, and nothing in other bundles", () => {
    const manifest = JSON.parse(readFileSync(new URL("../extension/manifest.json", import.meta.url), "utf8"));
    const sources = {"background.js":readFileSync(new URL("../src/extension/background.mjs", import.meta.url), "utf8"), "content.js":`const lib = {files:["vendor.js"], page:"help.html"};`};
    const required = requiredEntries(manifest, Object.keys(sources), (entry) => sources[entry]);
    expect(required).toContain("content.js");
    expect(required).toContain("offscreen.html");
    expect(required).not.toContain("vendor.js");
    expect(required).not.toContain("help.html");
  });

  test("takes only the options it knows", () => {
    expect(parseOptions(["--expected-version", "1.0.0", "--output", "x.zip"])).toEqual({expectedVersion:"1.0.0", output:"x.zip"});
    expect(() => parseOptions(["--unpacked"])).toThrow("unknown option");
    expect(() => parseOptions(["--output"])).toThrow("requires a value");
  });
});
