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
  // `files` serves the page and those paths from https://example.test/, so they share its origin.
  // `requests` collects every url asked for while the capture runs, after the page has loaded.
  const captureHtml = async function captureHtml(html, selector = "#root", {viewport = {width:800, height:600}, before, screenshot = false, files = null, requests = null} = {}) {
    const page = await state.browser.newPage({viewport, deviceScaleFactor:1});
    try {
      const document = `<!doctype html><html><body style="margin:0">${html}</body></html>`;
      if (files) {
        await page.route("https://example.test/**", (route) => {
          const path = new URL(route.request().url()).pathname;
          if (path === "/page") return route.fulfill({contentType:"text/html", body:document});
          return files[path] ? route.fulfill({contentType:"image/svg+xml", body:files[path]}) : route.fulfill({status:404, body:""});
        });
        await page.goto("https://example.test/page", {waitUntil:"load"});
      } else {
        await page.setContent(document, {waitUntil:"load"});
      }
      if (before) await page.evaluate(before);
      if (requests) page.on("request", (request) => requests.push(request.url()));
      await page.addScriptTag({content:state.script});
      const png = screenshot ? await page.locator(selector).screenshot({animations:"disabled"}) : null;
      const capture = await page.evaluate((selector) => globalThis.OpenPencilCapture.captureElement(document.querySelector(selector), {url:"https://example.test/page", capturedAt:"2026-11-07T00:00:00.000Z"}), selector);
      return screenshot ? {capture, png} : capture;
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
