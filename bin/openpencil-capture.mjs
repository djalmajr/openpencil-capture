#!/usr/bin/env bun
import { readFile, writeFile } from "node:fs/promises";
import { captureUrl } from "../src/capture-url.mjs";
import { convertCaptureToTree } from "../src/convert-capture.mjs";
import { createClipboardFromTree } from "../src/openpencil-clipboard.mjs";

const argv = process.argv.slice(2);
const [command, ...rest] = argv;
const usage = () => { console.error("Usage: openpencil-capture capture --url <url> --selector <selector> --output <capture.json> [--screenshot <source.png>] | <verify|convert|clipboard> <input> [output]"); process.exit(2); };
const parseOptions = values => {
  const options = {};
  for (let index = 0; index < values.length; index += 1) {
    const item = values[index];
    if (!item.startsWith("--")) throw new Error(`unexpected argument: ${item}`);
    const key = item.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith("--")) options[key] = true;
    else { options[key] = next; index += 1; }
  }
  return options;
};
if (!command) usage();
if (command === "capture") {
  console.log(JSON.stringify(await captureUrl(parseOptions(rest)), null, 2));
  process.exit(0);
}
const [inputPath, outputPath] = rest;
if (!inputPath) usage();
const input = JSON.parse(await readFile(inputPath, "utf8"));
if (command === "verify") {
  if (input.format !== "openpencil-capture-ir" || input.version !== 1 || !Array.isArray(input.nodes)) throw new Error("Invalid OpenPencil capture IR");
  console.log(JSON.stringify({ label:input.label, nodes:input.nodes.length, rootPath:input.rootPath }, null, 2));
} else if (command === "convert") {
  if (!outputPath) usage();
  const result = convertCaptureToTree(input);
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result.stats));
} else if (command === "clipboard") {
  if (!outputPath) usage();
  const { html, missingImages } = await createClipboardFromTree(convertCaptureToTree(input).root);
  await writeFile(outputPath, html);
  console.log(JSON.stringify({ bytes:html.length, missingImages }));
} else usage();
