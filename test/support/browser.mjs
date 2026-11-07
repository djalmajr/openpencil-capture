import { afterAll, beforeAll } from "bun:test";
import { chromium } from "playwright";
import { captureBundle, captureTarget } from "../../src/capture-url.mjs";

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
        // A path serves on the page's origin, a full url on its own; .html files as pages.
        await page.route(/^https:\/\/[a-z.]+\.test\//, (route) => {
          const url = new URL(route.request().url());
          if (url.href === "https://example.test/page") return route.fulfill({contentType:"text/html", body:document});
          const body = url.origin === "https://example.test" ? files[url.pathname] : files[url.href];
          if (body == null) return route.fulfill({status:404, body:""});
          return route.fulfill({contentType:url.pathname.endsWith(".html") ? "text/html" : url.pathname.endsWith(".txt") ? "text/plain" : "image/svg+xml", body});
        });
        await page.goto("https://example.test/page", {waitUntil:"load"});
      } else {
        await page.setContent(document, {waitUntil:"load"});
      }
      if (before) await page.evaluate(before);
      if (requests) page.on("request", (request) => requests.push(request.url()));
      await page.addScriptTag({content:state.script});
      const png = screenshot ? await page.locator(selector).screenshot({animations:"disabled"}) : null;
      const capture = await captureTarget(page.locator(selector).first(), {url:"https://example.test/page", capturedAt:"2026-11-07T00:00:00.000Z"}, state.script);
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
