import { fetchExtensionAsset } from "./asset-fetch.mjs";
import { FRAME_CAPTURE_MESSAGE, frameRequest } from "./frame-request.mjs";

const OFFSCREEN_URL = "offscreen.html";
let creatingOffscreenDocument;

async function ensureOffscreenDocument() {
  const documentUrl = chrome.runtime.getURL(OFFSCREEN_URL);
  const contexts = await chrome.runtime.getContexts({
    contextTypes:["OFFSCREEN_DOCUMENT"],
    documentUrls:[documentUrl],
  });
  if (contexts.length > 0) return;
  if (!creatingOffscreenDocument) {
    creatingOffscreenDocument = chrome.offscreen.createDocument({
      url:OFFSCREEN_URL,
      reasons:["CLIPBOARD", "BLOBS"],
      justification:"Write the captured design from iframe and page documents, and rasterize images the editor cannot decode",
    }).finally(() => { creatingOffscreenDocument = undefined; });
  }
  await creatingOffscreenDocument;
}

async function askOffscreenDocument(message) {
  await ensureOffscreenDocument();
  return chrome.runtime.sendMessage(message);
}

function respondWith(work, sendResponse) {
  work()
    .then(sendResponse)
    .catch((error) => sendResponse({ok:false, error:error instanceof Error ? error.message : String(error)}));
  return true;
}

// A capture that finishes in one frame closes the pickers of the others, so frames can disagree
// about being open. The top frame decides for all of them: toggling each frame on its own would
// leave invisible pickers in iframes, waiting to swallow the next click.
async function toggleCapture(tabId) {
  const [top] = await chrome.scripting.executeScript({target:{tabId}, func:() => Boolean(globalThis.__openPencilCaptureController)});
  await chrome.scripting.executeScript({target:{tabId, allFrames:true}, func:() => globalThis.__openPencilCaptureController?.teardown()});
  if (!top?.result) await chrome.scripting.executeScript({target:{tabId, allFrames:true}, files:["content.js"]});
}

// The smoke tests drive the same path the toolbar button does.
globalThis.openPencilToggleCapture = toggleCapture;

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id) await toggleCapture(tab.id);
});

// A frame of another origin, captured for the page around it: only in the asking tab, by the
// content script already running in each frame's isolated world, which answers only if it is the
// frame asked for.
async function captureFrame(message, sender) {
  const tabId = sender.tab?.id;
  const request = frameRequest(message);
  if (sender.id !== chrome.runtime.id || !Number.isInteger(tabId) || !request) return {ok:false, error:"Invalid frame capture request"};
  const results = await chrome.scripting.executeScript({target:{tabId, allFrames:true}, func:(asked) => globalThis.__openPencilCaptureFrame?.(asked) ?? null, args:[request]});
  return {ok:true, capture:results.find((result) => result?.result)?.result ?? null};
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === FRAME_CAPTURE_MESSAGE) return respondWith(() => captureFrame(message, sender), sendResponse);
  if (message?.type === "openpencil-capture:write-clipboard") {
    return respondWith(() => askOffscreenDocument({type:"openpencil-capture:offscreen-write", html:message.html}), sendResponse);
  }
  if (message?.type !== "openpencil-capture:fetch-asset" || typeof message.url !== "string") return false;
  return respondWith(async () => {
    if (message.rasterize) {
      if (!message.url.startsWith("data:image/")) throw new Error("Only image data can be rasterized");
      return askOffscreenDocument({type:"openpencil-capture:offscreen-rasterize", dataUrl:message.url, box:message.rasterize});
    }
    return {ok:true, dataUrl:await fetchExtensionAsset(message.url)};
  }, sendResponse);
});
