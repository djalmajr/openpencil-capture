import { createSelectionState, selectChild, selectParent, setHoveredTarget } from "../selection/navigation.mjs";
import { captureProgressForElapsed } from "./capture-progress.mjs";
import { captureThisFrame } from "./capture-frame.mjs";
import { captureSelection } from "./capture-selection.mjs";
import { isPageCaptureShortcut, pageCaptureModifier } from "./shortcuts.mjs";

const CONTROLLER_KEY = "__openPencilCaptureController";

// The service worker calls this, in this script's isolated world, when the page around a frame of
// another origin captures it; page scripts cannot reach it.
globalThis.__openPencilCaptureFrame = captureThisFrame;
const FRAME_ACTIVITY_MESSAGE = "openpencil-capture:frame-activity";
const FRAME_CANCEL_MESSAGE = "openpencil-capture:frame-cancel";
const CAPTURE_TIMEOUT_MS = 65_000;
// Chrome refuses extension messages above 64 MiB.
const MAX_CLIPBOARD_CHARACTERS = 60 * 1024 * 1024;

async function requestAsset(detail) {
  const response = await chrome.runtime.sendMessage({type:"openpencil-capture:fetch-asset", ...detail});
  return response?.ok ? response.dataUrl : null;
}

// Runs in the isolated world on purpose: page scripts get no channel to the extension's fetch,
// and cannot alter the clipboard payload.
function copyDesign(target, sourceSelector) {
  let timeout;
  const timedOut = new Promise((resolve) => {
    timeout = setTimeout(() => resolve({ok:false, error:"Capture timed out"}), CAPTURE_TIMEOUT_MS);
  });
  const captured = captureSelection(target, sourceSelector, {requestAsset})
    .then((result) => ({ok:true, ...result}))
    .catch((error) => ({ok:false, error:error.message}));
  return Promise.race([captured, timedOut]).finally(() => clearTimeout(timeout));
}

async function writeToClipboard(html) {
  if (html.length > MAX_CLIPBOARD_CHARACTERS) {
    return {ok:false, error:"This capture is too large to copy. Select a smaller element."};
  }
  try {
    return await chrome.runtime.sendMessage({type:"openpencil-capture:write-clipboard", html});
  } catch (error) {
    return {ok:false, error:error.message};
  }
}

function selectorFor(element) {
  if (element === document.body) return "body";
  if (element === document.documentElement) return "html";
  if (element.id) return `#${CSS.escape(element.id)}`;
  const parts = [];
  let node = element;
  while (node && node !== document.body) {
    let part = node.tagName.toLowerCase();
    const siblings = node.parentElement
      ? Array.from(node.parentElement.children).filter((candidate) => candidate.tagName === node.tagName)
      : [];
    if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
    parts.unshift(part);
    if (node.id) {
      parts[0] = `#${CSS.escape(node.id)}`;
      break;
    }
    node = node.parentElement;
  }
  return `body > ${parts.join(" > ")}`;
}

function install() {
  if (globalThis[CONTROLLER_KEY]) return;
  const isEmbeddedDocument = globalThis.top !== globalThis;
  const pageModifier = pageCaptureModifier(navigator.platform);
  const host = document.createElement("div");
  host.id = "__openpencil_capture_host__";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .toolbar { position: fixed; z-index: 2147483647; top: 16px; left: 50%; transform: translateX(-50%); display: flex; align-items: center; min-height: 44px; box-sizing:border-box; overflow:hidden; padding: 7px 14px 7px 12px; border: 1px solid rgba(15,23,42,.18); border-radius: 12px; background: rgba(255,255,255,.96); box-shadow: 0 10px 28px rgba(15,23,42,.18),0 1px 2px rgba(15,23,42,.10); color: #262626; font: 14px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; white-space: nowrap; transition: opacity 90ms ease,width 140ms ease; }
      .toolbar.pass-through { opacity: 0; pointer-events: none; }
      .toolbar.frame-inactive { opacity: 0; pointer-events: none; }
      .capture-progress { position:absolute; z-index:0; inset:0; transform:scaleX(0); transform-origin:left center; background:#ECECEA; opacity:0; pointer-events:none; transition:transform 90ms linear,opacity 90ms ease; }
      .toolbar.is-capturing .capture-progress { opacity:1; }
      .view { position:relative; z-index:1; display:flex; align-items:center; gap:12px; }
      .view[hidden] { display:none !important; }
      .state-icon { display:grid; place-items:center; width:20px; height:20px; flex:0 0 20px; }
      .mark { display:block; width:20px; height:20px; transition:filter 120ms ease,opacity 120ms ease; }
      .capturing-view .mark { filter:grayscale(1); opacity:.55; }
      .capturing-view { min-width:220px; }
      .capturing-message { flex:1; }
      .capturing-percentage { min-width:34px; color:#737373; font-variant-numeric:tabular-nums; text-align:right; }
      .check { display:grid; place-items:center; width:20px; height:20px; border-radius:50%; background:#6691F2; color:white; font:700 14px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
      .instructions { display:flex; align-items:center; gap:12px; }
      .hint { display:inline-flex; align-items:center; gap:5px; }
      .keys { display:inline-flex; align-items:center; gap:3px; }
      kbd { display:inline-flex; align-items:center; justify-content:center; min-width:24px; height:24px; box-sizing:border-box; padding:0 6px; border:1px solid #D7D7D7; border-bottom-color:#BEBEBE; border-radius:5px; background:#FAFAFA; box-shadow:0 1px 1px rgba(0,0,0,.08); color:#333; font:12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; text-align:center; }
      .sep { width:3px; height:3px; border-radius:50%; background:#B7B7B7; flex:0 0 3px; }.message { color:#333; font-weight:400; }
      .outline { position:fixed; z-index:2147483646; pointer-events:none; box-sizing:border-box; border:2px solid #5794FF; background:rgba(87,148,255,.055); transition:left 35ms linear,top 35ms linear,width 35ms linear,height 35ms linear; }
    </style>
    <div class="toolbar">
      <span class="capture-progress" role="progressbar" aria-label="Capture progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"></span>
      <div class="view selection-view">
        <span class="state-icon"><img class="mark" src="${chrome.runtime.getURL("icons/openpencil-mark.png")}" alt="" /></span>
        <span class="instructions">
          <span class="hint">Click or <span class="keys"><kbd>↵</kbd></span> to capture</span>
          <span class="sep"></span>
          <span class="hint"><span class="keys"><kbd>${pageModifier}</kbd><kbd>↵</kbd></span> to capture page</span>
          <span class="sep"></span>
          <span class="hint"><span class="keys"><kbd>↑</kbd><kbd>↓</kbd></span> to fine-tune selection</span>
          <span class="sep"></span>
          <span class="hint"><span class="keys"><kbd>esc</kbd></span> to cancel</span>
        </span>
      </div>
      <div class="view capturing-view" hidden>
        <span class="state-icon"><img class="mark" src="${chrome.runtime.getURL("icons/openpencil-mark.png")}" alt="" /></span>
        <span class="message capturing-message">Capturing selection…</span>
        <span class="capturing-percentage">0%</span>
      </div>
      <div class="view success-view" hidden>
        <span class="state-icon"><span class="check">✓</span></span>
        <span class="message">Copied to clipboard. Ready to paste into OpenPencil.</span>
      </div>
    </div>
    <div class="outline"></div>`;
  document.documentElement.append(host);
  // The picker's own interface is never part of a capture.
  globalThis.__openPencilCaptureHost = host;
  const toolbar = shadow.querySelector(".toolbar");
  const outline = shadow.querySelector(".outline");
  const selectionView = shadow.querySelector(".selection-view");
  const capturingView = shadow.querySelector(".capturing-view");
  const successView = shadow.querySelector(".success-view");
  const capturingMessage = shadow.querySelector(".capturing-message");
  const capturingPercentage = shadow.querySelector(".capturing-percentage");
  const captureProgress = shadow.querySelector(".capture-progress");
  const selection = createSelectionState(document.body);
  let active = true;
  let phase = "selection";
  let progressAnimationFrame;
  let selectionSelector = "body";
  let lastPointer = null;
  toolbar.classList.toggle("frame-inactive", isEmbeddedDocument);

  function showView(nextPhase) {
    phase = nextPhase;
    toolbar.classList.toggle("is-capturing", nextPhase === "capturing");
    selectionView.hidden = nextPhase !== "selection";
    capturingView.hidden = nextPhase !== "capturing";
    successView.hidden = nextPhase !== "success";
  }

  function setCaptureProgress(percent) {
    const value = Math.max(0, Math.min(100, Math.round(percent)));
    captureProgress.style.transform = `scaleX(${value / 100})`;
    captureProgress.setAttribute("aria-valuenow", String(value));
    capturingPercentage.textContent = `${value}%`;
  }

  function stopCaptureProgress(percent) {
    if (progressAnimationFrame) cancelAnimationFrame(progressAnimationFrame);
    progressAnimationFrame = undefined;
    if (percent !== undefined) setCaptureProgress(percent);
  }

  function startCaptureProgress() {
    stopCaptureProgress(0);
    capturingPercentage.hidden = false;
    const startedAt = performance.now();
    const update = () => {
      if (!active || phase !== "capturing") return;
      setCaptureProgress(captureProgressForElapsed(performance.now() - startedAt));
      progressAnimationFrame = requestAnimationFrame(update);
    };
    update();
  }

  function updateOutline() {
    const target = selection.current;
    if (!target || target === host || toolbar.classList.contains("frame-inactive")) return outline.style.display = "none";
    const rect = target.getBoundingClientRect();
    Object.assign(outline.style, { display:"block", left:`${rect.left}px`, top:`${rect.top}px`, width:`${rect.width}px`, height:`${rect.height}px` });
  }

  // Page scripts can dispatch events too. Only the user's own input may select or capture.
  function onPointerMove(event) {
    if (!event.isTrusted || !active || phase !== "selection") return;
    toolbar.classList.remove("frame-inactive");
    if (isEmbeddedDocument) globalThis.top.postMessage({type:FRAME_ACTIVITY_MESSAGE}, "*");
    lastPointer = {x:event.clientX,y:event.clientY};
    const rect = toolbar.getBoundingClientRect();
    const overToolbar = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
    toolbar.classList.toggle("pass-through", overToolbar);
    const target = document.elementFromPoint(event.clientX, event.clientY);
    if (target?.matches?.("iframe,frame")) {
      toolbar.classList.add("frame-inactive");
      outline.style.display = "none";
      return;
    }
    if (target && target !== host && !host.contains(target)) {
      setHoveredTarget(selection, target);
      selectionSelector = selectorFor(target);
      updateOutline();
    }
  }

  function broadcastFrameCancel() {
    for (let index = 0; index < globalThis.frames.length; index += 1) {
      globalThis.frames[index].postMessage({type:FRAME_CANCEL_MESSAGE}, "*");
    }
  }

  // Left running, another frame's picker would swallow the next click and overwrite the clipboard.
  function stopOtherFrames() {
    if (isEmbeddedDocument) globalThis.top.postMessage({type:FRAME_CANCEL_MESSAGE}, "*");
    else broadcastFrameCancel();
  }

  function onFrameMessage(event) {
    if (!active || event.source === globalThis || phase === "success") return;
    if (event.data?.type === FRAME_CANCEL_MESSAGE) {
      broadcastFrameCancel();
      teardown();
      return;
    }
    if (!isEmbeddedDocument && event.data?.type === FRAME_ACTIVITY_MESSAGE) {
      toolbar.classList.add("frame-inactive");
      outline.style.display = "none";
    }
  }

  function resolveLiveTarget(target, fallbackTarget) {
    if (target instanceof Element && target.isConnected) return target;
    try {
      const replacement = document.querySelector(selectionSelector);
      if (replacement instanceof Element && replacement !== host && !host.contains(replacement)) return replacement;
    } catch {}
    if (fallbackTarget instanceof Element && fallbackTarget.isConnected && fallbackTarget !== host && !host.contains(fallbackTarget)) return fallbackTarget;
    if (lastPointer) {
      const pointedTarget = document.elementFromPoint(lastPointer.x,lastPointer.y);
      if (pointedTarget instanceof Element && pointedTarget !== host && !host.contains(pointedTarget)) return pointedTarget;
    }
    return null;
  }

  async function capture(target, fallbackTarget) {
    if (phase !== "selection") return;
    target = resolveLiveTarget(target, fallbackTarget);
    if (!target) {
      capturingMessage.textContent = "The selected element is no longer available";
      showView("capturing");
      toolbar.classList.remove("is-capturing");
      capturingPercentage.hidden = true;
      return;
    }
    const sourceSelector = selectorFor(target);
    capturingMessage.textContent = target === document.body ? "Capturing page…" : "Capturing selection…";
    showView("capturing");
    startCaptureProgress();
    const capturingStartedAt = performance.now();
    const response = await copyDesign(target, sourceSelector);
    if (!active) return;
    const minimumCapturingTime = 450;
    const remainingCapturingTime = minimumCapturingTime - (performance.now() - capturingStartedAt);
    if (remainingCapturingTime > 0) await new Promise((resolve) => setTimeout(resolve, remainingCapturingTime));
    if (!active) return;
    let completion = response;
    if (response?.ok) {
      completion = await writeToClipboard(response.html);
    }
    if (!completion?.ok) {
      stopCaptureProgress();
      toolbar.classList.remove("is-capturing");
      capturingPercentage.hidden = true;
      capturingMessage.textContent = completion?.error || "Could not copy design";
      return;
    }
    stopCaptureProgress(100);
    await new Promise((resolve) => setTimeout(resolve, 120));
    if (!active) return;
    showView("success");
    stopOtherFrames();
    setTimeout(teardown, 2400);
  }

  function onClick(event) {
    if (!event.isTrusted || !active || phase !== "selection" || event.target === host || host.contains(event.target)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    capture(selection.current, event.target);
  }

  function cancelFromKeyboard(event) {
    if (!event.isTrusted || !active) return false;
    if (event.key === "Escape" || event.key === "Esc" || event.keyCode === 27) {
      event.preventDefault();
      event.stopImmediatePropagation();
      stopOtherFrames();
      teardown();
      return true;
    }
    return false;
  }

  function onKeyDown(event) {
    if (!event.isTrusted || !active || cancelFromKeyboard(event)) return;
    if (phase !== "selection") return;
    if (event.key === "ArrowUp") { event.preventDefault(); selectParent(selection, document.documentElement); selectionSelector = selectorFor(selection.current); return updateOutline(); }
    if (event.key === "ArrowDown") { event.preventDefault(); selectChild(selection); selectionSelector = selectorFor(selection.current); return updateOutline(); }
    if (event.key === "Enter") { event.preventDefault(); return capture(isPageCaptureShortcut(event) ? document.body : selection.current); }
  }

  function teardown() {
    if (!active) return;
    active = false;
    stopCaptureProgress();
    document.removeEventListener("mousemove", onPointerMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKeyDown, true);
    globalThis.removeEventListener("keydown", cancelFromKeyboard, true);
    globalThis.removeEventListener("message", onFrameMessage);
    host.remove();
    delete globalThis[CONTROLLER_KEY];
  }

  document.addEventListener("mousemove", onPointerMove, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKeyDown, true);
  globalThis.addEventListener("keydown", cancelFromKeyboard, true);
  globalThis.addEventListener("message", onFrameMessage);
  updateOutline();
  globalThis[CONTROLLER_KEY] = { teardown };
}

install();
