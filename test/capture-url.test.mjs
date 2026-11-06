import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureUrl } from "../src/capture-url.mjs";

const server = Bun.serve({
  port: 0,
  fetch() {
    return new Response(`<!doctype html><html lang="en"><style>
      body{margin:0;font-family:Arial,sans-serif}
      #fixture{width:240px;padding:16px;border:1px solid rgb(220,220,220);border-radius:8px}
      button{height:36px;padding:0 16px;background:rgb(24,24,27);color:white;border:0;border-radius:6px}
    </style><body><main id="fixture"><button type="button">Create board</button></main></body></html>`, {
      headers: {"content-type": "text/html; charset=utf-8"}
    });
  }
});

afterAll(() => server.stop(true));

describe("captureUrl", () => {
  test("captures a deterministic browser fixture to the neutral IR", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openpencil-capture-url-"));
    try {
      const output = join(directory, "button.capture.json");
      const screenshot = join(directory, "button.png");
      const result = await captureUrl({
        url: `http://127.0.0.1:${server.port}`,
        selector: "#fixture",
        output,
        screenshot,
        width: "640",
        height: "480",
        "settle-ms": "0",
        "captured-at": "2026-07-20T12:00:00.000Z"
      });
      const capture = JSON.parse(await readFile(output, "utf8"));
      expect(result.nodes).toBe(2);
      expect(capture).toMatchObject({
        format: "openpencil-capture-ir",
        version: 1,
        capturedAt: "2026-07-20T12:00:00.000Z",
        source: {selector: "#fixture"},
        environment: {locale: "en-US", timezone: "UTC", viewport: {width: 640, height: 480}}
      });
      expect(capture.nodes[1]).toMatchObject({tag: "button", text: "Create board"});
      expect((await Bun.file(screenshot).arrayBuffer()).byteLength).toBeGreaterThan(100);
    } finally {
      await rm(directory, {recursive: true, force: true});
    }
  });
});
