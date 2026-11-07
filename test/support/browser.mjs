import { afterAll, beforeAll } from "bun:test";
import { chromium } from "playwright";
import { captureBundle } from "../../src/capture-url.mjs";

// One Chromium for the whole file: each capture opens a page, renders the fixture, and runs the
// same bundle the CLI injects.
export function useBrowser() {
  const state = {};
  beforeAll(async () => {
    state.browser = await chromium.launch({headless:true});
    state.script = await captureBundle();
  });
  afterAll(() => state.browser?.close());
  const captureHtml = async function captureHtml(html, selector = "#root", {viewport = {width:800, height:600}, before} = {}) {
    const page = await state.browser.newPage({viewport, deviceScaleFactor:1});
    try {
      await page.setContent(`<!doctype html><html><body style="margin:0">${html}</body></html>`, {waitUntil:"load"});
      if (before) await page.evaluate(before);
      await page.addScriptTag({content:state.script});
      return await page.evaluate((selector) => globalThis.OpenPencilCapture.captureElement(document.querySelector(selector), {url:"https://example.test/page", capturedAt:"2026-11-07T00:00:00.000Z"}), selector);
    } finally {
      await page.close();
    }
  };
  // Runs `fn` in a blank page, for asking the browser itself how it renders something.
  captureHtml.evaluate = async (fn, argument) => {
    const page = await state.browser.newPage();
    try { return await page.evaluate(fn, argument); } finally { await page.close(); }
  };
  return captureHtml;
}
