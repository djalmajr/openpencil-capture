import { rasterizeImage } from "./rasterize.mjs";
import { writeClipboardPayload } from "./write-clipboard.mjs";

const respondWith = (work, sendResponse) => {
  work()
    .then(sendResponse)
    .catch((error) => sendResponse({ok:false, error:error instanceof Error ? error.message : String(error)}));
  return true;
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "openpencil-capture:offscreen-write") {
    return respondWith(() => writeClipboardPayload(message), sendResponse);
  }
  if (message?.type === "openpencil-capture:offscreen-rasterize") {
    return respondWith(async () => ({ok:true, dataUrl:await rasterizeImage(message.dataUrl, message.box)}), sendResponse);
  }
  return false;
});
