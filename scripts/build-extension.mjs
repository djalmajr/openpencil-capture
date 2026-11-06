import { cp, mkdir, rm } from "node:fs/promises";

const output = new URL("../dist/extension/", import.meta.url);
await rm(output, { force:true, recursive:true });
await mkdir(output, { recursive:true });
// The content script is injected again on each toolbar click, so it must not leak top-level names.
for (const [entrypoint, name, format] of [["src/extension/content.mjs","content.js","iife"],["src/extension/background.mjs","background.js","esm"],["src/extension/offscreen.mjs","offscreen.js","esm"]]) {
  const result = await Bun.build({ entrypoints:[entrypoint], outdir:output.pathname, naming:name, format, minify:false });
  if (!result.success) throw new AggregateError(result.logs, `Failed to build ${entrypoint}`);
}
await cp(new URL("../extension/manifest.json", import.meta.url), new URL("manifest.json", output));
await cp(new URL("../extension/offscreen.html", import.meta.url), new URL("offscreen.html", output));
await cp(new URL("../extension/icons/", import.meta.url), new URL("icons/", output), { recursive:true });
console.log(output.pathname);
