import { mkdir, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const [sourcePath, targetPath, outputDirectory] = args;
if (!sourcePath || !targetPath || !outputDirectory) {
  console.error("Usage: bun scripts/compare-visual.mjs <source.png> <openpencil.png> <output-directory> [--max-rmse <0..1>] [--require-same-size]");
  process.exit(2);
}

let maxRmse = null;
let requireSameSize = false;
for (let index = 3; index < args.length; index += 1) {
  const argument = args[index];
  if (argument === "--require-same-size") {
    requireSameSize = true;
    continue;
  }
  if (argument === "--max-rmse") {
    maxRmse = Number(args[index + 1]);
    index += 1;
    if (!Number.isFinite(maxRmse) || maxRmse < 0 || maxRmse > 1) {
      throw new Error("--max-rmse must be a number between 0 and 1");
    }
    continue;
  }
  throw new Error(`Unknown argument: ${argument}`);
}

function run(command, args, allowDifference = false) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 || (allowDifference && code === 1)) resolvePromise({stdout,stderr,code});
      else reject(new Error(`${command} exited with ${code}: ${stderr}`));
    });
  });
}

async function dimensions(path) {
  const result = await run("magick", ["identify", "-format", "%w %h", path]);
  const [width, height] = result.stdout.trim().split(/\s+/).map(Number);
  return {width,height};
}

const source = resolve(sourcePath);
const target = resolve(targetPath);
const output = resolve(outputDirectory);
await mkdir(output, {recursive:true});
const sourceDimensions = await dimensions(source);
const targetDimensions = await dimensions(target);
const normalizedTarget = `${output}/openpencil-normalized.png`;
const diff = `${output}/diff.png`;
const sideBySide = `${output}/side-by-side.png`;
await run("magick", [target, "-resize", `${sourceDimensions.width}x${sourceDimensions.height}!`, normalizedTarget]);
const metricResult = await run("magick", ["compare", "-metric", "RMSE", source, normalizedTarget, diff], true);
await run("magick", [source, normalizedTarget, "+append", sideBySide]);
const metricMatch = metricResult.stderr.match(/([\d.]+)\s*\(([\d.]+)\)/);
const normalizedRmse = metricMatch ? Number(metricMatch[2]) : null;
const sameSize = targetDimensions.width === sourceDimensions.width && targetDimensions.height === sourceDimensions.height;
const gates = {
  requireSameSize,
  maxRmse,
  sameSize,
  sizePassed:!requireSameSize || sameSize,
  rmsePassed:maxRmse === null || (normalizedRmse !== null && normalizedRmse <= maxRmse),
};
gates.passed = gates.sizePassed && gates.rmsePassed;
const report = {
  source:{path:source, ...sourceDimensions},
  openpencil:{path:target, ...targetDimensions},
  normalized:!sameSize,
  rmse:metricMatch ? Number(metricMatch[1]) : null,
  normalizedRmse,
  gates,
  outputs:{diff,sideBySide,normalizedTarget},
};
await writeFile(`${output}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
await writeFile(`${output}/report.html`, `<!doctype html><meta charset="utf-8"><title>OpenPencil Capture visual comparison</title><style>body{font:14px system-ui;margin:24px;background:#f5f5f2;color:#181817}main{max-width:1400px;margin:auto}section{margin:24px 0}img{max-width:100%;border:1px solid #ddd;background:white}code{background:#e9e9e5;padding:2px 5px;border-radius:4px}</style><main><h1>OpenPencil Capture visual comparison</h1><p>RMSE: <code>${report.rmse}</code> · normalized RMSE: <code>${report.normalizedRmse}</code> · resized: <code>${report.normalized}</code></p><section><h2>Source × Pen</h2><img src="${basename(sideBySide)}"></section><section><h2>Pixel difference</h2><img src="${basename(diff)}"></section></main>`);
console.log(JSON.stringify(report));
if (!gates.passed) process.exitCode = 1;
