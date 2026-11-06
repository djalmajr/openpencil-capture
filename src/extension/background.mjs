import { fetchExtensionAsset } from "./asset-fetch.mjs";

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

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  const target = { tabId:tab.id, allFrames:true };
  await chrome.scripting.executeScript({ target, world:"MAIN", files:["bridge.js"] });
  await chrome.scripting.executeScript({ target, files:["content.js"] });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "openpencil-capture:write-clipboard") {
    return respondWith(() => askOffscreenDocument({type:"openpencil-capture:offscreen-write", html:message.html}), sendResponse);
  }
  if (message?.type !== "openpencil-capture:fetch-asset" || typeof message.url !== "string") return false;
  return respondWith(async () => {
    if (message.rasterize) {
      return askOffscreenDocument({type:"openpencil-capture:offscreen-rasterize", dataUrl:message.url, box:message.rasterize});
    }
    return {ok:true, dataUrl:await fetchExtensionAsset(message.url)};
  }, sendResponse);
});
