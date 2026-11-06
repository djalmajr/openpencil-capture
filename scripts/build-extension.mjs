import { cp, mkdir, rm } from "node:fs/promises";

const output = new URL("../dist/extension/", import.meta.url);
await rm(output, { force:true, recursive:true });
await mkdir(output, { recursive:true });
for (const [entrypoint, name] of [["src/extension/content.mjs","content.js"],["src/extension/background.mjs","background.js"],["src/extension/offscreen.mjs","offscreen.js"]]) {
  const result = await Bun.build({ entrypoints:[entrypoint], outdir:output.pathname, naming:name, format:"esm", minify:false });
  if (!result.success) throw new AggregateError(result.logs, `Failed to build ${entrypoint}`);
}
const bridge = await Bun.build({
  entrypoints:["src/extension/main-world-bridge.mjs"],
  outdir:output.pathname,
  naming:"bridge.js",
  format:"iife",
  minify:false,
});
if (!bridge.success) throw new AggregateError(bridge.logs, "Failed to build the main-world bridge");
await cp(new URL("../extension/manifest.json", import.meta.url), new URL("manifest.json", output));
await cp(new URL("../extension/offscreen.html", import.meta.url), new URL("offscreen.html", output));
await cp(new URL("../extension/icons/", import.meta.url), new URL("icons/", output), { recursive:true });
console.log(output.pathname);
