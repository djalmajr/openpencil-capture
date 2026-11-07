#!/usr/bin/env bun
// Packages dist/extension as the ZIP the Chrome Web Store takes, which also installs by hand:
// extract it and choose the folder with Chrome's "Load unpacked". The manifest carries no `key`,
// so the Store assigns the extension ID.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync, zipSync } from "fflate";

const root = fileURLToPath(new URL("..", import.meta.url));
// A fixed date, so the same build packs to the same bytes. ZIP stores local wall time, which
// fflate reads with local getters, so the date is built in local time to be the same everywhere.
const ARCHIVE_DATE = new Date(2026, 0, 1, 12, 0, 0);

const walk = (directory, base = directory) => readdirSync(directory, {withFileTypes:true}).flatMap((item) => {
  const path = join(directory, item.name);
  if (item.isDirectory()) return walk(path, base);
  return item.isFile() ? [relative(base, path).split(sep).join("/")] : [];
});

/** The release version: the manifest's and the package's, which must be the same. */
export function extensionVersion(rootDirectory = root) {
  const manifest = JSON.parse(readFileSync(join(rootDirectory, "extension/manifest.json"), "utf8"));
  const pkg = JSON.parse(readFileSync(join(rootDirectory, "package.json"), "utf8"));
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error(`invalid extension version: ${manifest.version}`);
  if (manifest.version !== pkg.version) throw new Error(`version mismatch: manifest=${manifest.version}, package=${pkg.version}`);
  return manifest.version;
}

/** Every file the manifest and the code load, which the archive must hold. */
export function requiredEntries(manifest, entries, readEntry) {
  const required = [manifest.background?.service_worker, ...Object.values(manifest.icons ?? {}), ...Object.values(manifest.action?.default_icon ?? {})];
  for (const resource of manifest.web_accessible_resources ?? []) required.push(...resource.resources);
  // Scripts the service worker injects (`files:["content.js"]`) and pages it opens; only the
  // worker is read, so a string inside a bundled library cannot stand for a file.
  const worker = manifest.background?.service_worker;
  if (worker && entries.includes(worker)) {
    const source = readEntry(worker);
    for (const [, list] of source.matchAll(/files:\s*\[([^\]]*)\]/g)) required.push(...Array.from(list.matchAll(/["']([^"']+)["']/g), (match) => match[1]));
    for (const [, page] of source.matchAll(/["']([\w./-]+\.html)["']/g)) required.push(page);
  }
  for (const entry of entries.filter((name) => name.endsWith(".html"))) {
    for (const [, source] of readEntry(entry).matchAll(/(?:src|href)="([^"?#:]+)"/g)) required.push(join(dirname(entry), source).split(sep).join("/"));
  }
  return [...new Set(required.filter(Boolean))].sort();
}

/** Refuses an archive the Store would reject or that ships what it should not. */
export function validateEntries(manifest, entries, readEntry) {
  const problems = [];
  if (!entries.includes("manifest.json")) problems.push("manifest.json must be at the archive root");
  if (manifest.key) problems.push("manifest.key must not be shipped: the Store assigns the extension ID");
  for (const entry of entries) {
    if (entry.startsWith("/") || entry.split("/").includes("..")) problems.push(`unsafe path: ${entry}`);
    if (/\.(map|zip)$|\.test\.|(^|\/)\./.test(entry)) problems.push(`not a runtime file: ${entry}`);
  }
  const missing = requiredEntries(manifest, entries, readEntry).filter((entry) => !entries.includes(entry));
  if (missing.length) problems.push(`missing from the archive: ${missing.join(", ")}`);
  if (problems.length) throw new Error(problems.join("\n"));
}

export function packageExtension({expectedVersion, output, rootDirectory = root, build = true} = {}) {
  if (build) execFileSync("bun", ["scripts/build-extension.mjs"], {cwd:rootDirectory, stdio:"inherit"});
  const version = extensionVersion(rootDirectory);
  if (expectedVersion && expectedVersion !== version) throw new Error(`expected version ${expectedVersion}; the source is ${version}`);
  const directory = join(rootDirectory, "dist/extension");
  const entries = walk(directory).sort();
  const readEntry = (entry) => readFileSync(join(directory, entry), "utf8");
  const manifest = JSON.parse(readEntry("manifest.json"));
  if (manifest.version !== version) throw new Error(`dist/extension is stale: its manifest says ${manifest.version}`);
  validateEntries(manifest, entries, readEntry);
  const archive = zipSync(Object.fromEntries(entries.map((entry) => [entry, [readFileSync(join(directory, entry)), {mtime:ARCHIVE_DATE, level:9}]])));
  // Read back: the archive must hold exactly the validated files, byte for byte.
  const unpacked = unzipSync(archive);
  if (Object.keys(unpacked).sort().join("\n") !== entries.join("\n")) throw new Error("the archive differs from the validated file list");
  for (const entry of entries) {
    if (Buffer.compare(Buffer.from(unpacked[entry]), readFileSync(join(directory, entry))) !== 0) throw new Error(`the archive changed ${entry}`);
  }
  const outputPath = resolve(rootDirectory, output ?? `artifacts/openpencil-capture-${version}.zip`);
  mkdirSync(dirname(outputPath), {recursive:true});
  writeFileSync(outputPath, archive);
  return {version, outputPath, entries, size:statSync(outputPath).size, sha256:createHash("sha256").update(archive).digest("hex")};
}

export function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const [name, value] = [args[index], args[index + 1]];
    if (!["--expected-version", "--output"].includes(name)) throw new Error(`unknown option: ${name}`);
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
    options[name === "--output" ? "output" : "expectedVersion"] = value;
  }
  return options;
}

if (import.meta.main) {
  const result = packageExtension(parseOptions(process.argv.slice(2)));
  console.log(`version: ${result.version}\nfile: ${result.outputPath}\nentries: ${result.entries.length}\nsize: ${result.size}\nsha256: ${result.sha256}`);
}
