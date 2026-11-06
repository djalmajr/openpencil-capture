const TYPES = ["text/html", "text/plain"];

function writeWithCopyEvent(payload, documentRef) {
  const onCopy = (event) => {
    for (const type of TYPES) event.clipboardData.setData(type, payload);
    event.preventDefault();
  };
  documentRef.addEventListener("copy", onCopy, {once:true});
  const copied = documentRef.execCommand("copy");
  if (!copied) documentRef.removeEventListener("copy", onCopy);
  return copied;
}

/**
 * Both flavors carry the same envelope: browsers read it from the raw HTML, while the desktop app's
 * WebKit strips the comment and falls through to its plain-text route. The copy event comes first
 * because it writes the HTML verbatim; `clipboard.write` reserializes it with document markup.
 */
export async function writeClipboardPayload({html}, options = {}) {
  if (typeof html !== "string") throw new TypeError("Clipboard payload requires HTML");
  const clipboard = "clipboard" in options ? options.clipboard : navigator.clipboard;
  const documentRef = "documentRef" in options ? options.documentRef : document;
  if (documentRef?.execCommand && writeWithCopyEvent(html, documentRef)) return {ok:true, types:TYPES};
  if (!clipboard) throw new Error("The extension could not write the captured design to the clipboard");
  await clipboard.write([new ClipboardItem(Object.fromEntries(TYPES.map((type) => [type, new Blob([html], {type})])))]);
  return {ok:true, types:TYPES};
}
