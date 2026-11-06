export function pageCaptureModifier(platform = "") {
  return /mac|iphone|ipad|ipod/i.test(platform) ? "⌘" : "Ctrl";
}

export function isPageCaptureShortcut(event) {
  return event.key === "Enter" && (event.metaKey || event.ctrlKey);
}
