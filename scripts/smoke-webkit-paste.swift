// Pastes a captured envelope through what the desktop app runs on: a WKWebView, a native paste:
// action and the real editor code, with the Tauri clipboard plugin answering from NSPasteboard.
// It never opens the installed app; the general pasteboard is saved first and restored at exit.
import Cocoa
import WebKit

let arguments = CommandLine.arguments
guard arguments.count >= 2, let envelope = try? String(contentsOfFile: arguments[1], encoding: .utf8) else {
  print("Usage: smoke-webkit-paste <envelope.txt> [editor-url] [screenshot.png]")
  exit(2)
}
let editorURL = URL(string: arguments.count > 2 ? arguments[2] : "https://app.openpencil.dev/")!
let screenshotPath = arguments.count > 3 ? arguments[3] : nil

let tauriShim = """
(() => {
  let nextCallback = 1;
  const callbacks = new Map();
  Object.defineProperty(window, '__TAURI_INTERNALS__', {configurable: true, value: {
    callbacks,
    metadata: {currentWindow: {label: 'main'}, currentWebview: {label: 'main'}},
    convertFileSrc: (path) => path,
    invoke: (cmd, args) => window.webkit.messageHandlers.ipc.postMessage({cmd, args: args ?? null}),
    transformCallback: (callback) => { const id = nextCallback++; callbacks.set(id, callback); return id; },
    unregisterCallback: (id) => callbacks.delete(id),
    runCallback: () => null,
  }});
  window.__TAURI_OS_PLUGIN_INTERNALS__ = {platform: 'macos', version: '26', family: 'unix', arch: 'aarch64', os_type: 'macos', exe_extension: '', eol: '\\n', locale: 'en-US', hostname: 'smoke'};
  window.__pasteProbe = [];
  window.addEventListener('paste', (event) => window.__pasteProbe.push({
    html: event.clipboardData.getData('text/html').length,
    plain: event.clipboardData.getData('text/plain').length,
  }), true);
})();
"""

let summarizeGraph = """
const store = window.openPencil.getStore();
const pageId = store.state.currentPageId;
const flatten = (id) => store.graph.getChildren(id).flatMap((node) => [node, ...flatten(node.id)]);
const nodes = flatten(pageId);
const counts = {};
for (const node of nodes) counts[node.type] = (counts[node.type] || 0) + 1;
const imageFills = nodes.flatMap((node) => node.fills).filter((fill) => fill.type === 'IMAGE');
const roots = store.graph.getChildren(pageId);
return JSON.stringify({
  isTauri: '__TAURI_INTERNALS__' in window,
  pasteEvents: window.__pasteProbe,
  roots: roots.map(({name, type, width, height}) => ({name, type, width, height})),
  counts,
  imageFills: imageFills.length,
  imagesWithBytes: imageFills.filter((fill) => store.graph.images.has(fill.imageHash)).length,
  selected: store.state.selectedIds.size,
  sampleText: nodes.find((node) => node.type === 'TEXT')?.text ?? null,
});
"""

final class Harness: NSObject, WKScriptMessageHandlerWithReply, WKNavigationDelegate {
  var web: WKWebView!
  var window: NSWindow!
  var saved: [NSPasteboardItem] = []
  var readTextCalls = 0
  var envelope = ""
  var screenshotPath: String?

  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
    let body = message.body as? [String: Any]
    switch body?["cmd"] as? String {
    case "plugin:clipboard-manager|read_text":
      readTextCalls += 1
      replyHandler(NSPasteboard.general.string(forType: .string) ?? "", nil)
    case "list_system_fonts", "take_pending_open":
      replyHandler([Any](), nil)
    default:
      replyHandler(NSNull(), nil)
    }
  }

  func savePasteboard() {
    saved = (NSPasteboard.general.pasteboardItems ?? []).map { item in
      let copy = NSPasteboardItem()
      for type in item.types { if let data = item.data(forType: type) { copy.setData(data, forType: type) } }
      return copy
    }
  }

  func restorePasteboard() {
    NSPasteboard.general.clearContents()
    if !saved.isEmpty { NSPasteboard.general.writeObjects(saved) }
  }

  func finish(_ code: Int32) {
    restorePasteboard()
    exit(code)
  }

  func evaluate(_ script: String, _ done: @escaping (Any?) -> Void) {
    web.callAsyncJavaScript(script, arguments: [:], in: nil, in: .page) { result in
      switch result {
      case .success(let value): done(value)
      case .failure(let error):
        print("evaluate failed: \(error)")
        done(nil)
      }
    }
  }

  func waitFor(_ script: String, attempts: Int = 120, _ done: @escaping () -> Void) {
    evaluate(script) { value in
      if (value as? Bool) == true { return done() }
      if attempts == 0 { print("timed out waiting for: \(script)"); return self.finish(1) }
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.waitFor(script, attempts: attempts - 1, done) }
    }
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    // The home screen has no editor store yet; a new document opens one.
    waitFor("return !!document.querySelector('[data-test-id=\"home-new-document\"]') || !!window.openPencil?.getStore") {
      self.evaluate("document.querySelector('[data-test-id=\"home-new-document\"]')?.click(); return true") { _ in
        self.waitFor("try { return !!window.openPencil.getStore().state.currentPageId } catch { return false }") {
          DispatchQueue.main.asyncAfter(deadline: .now() + 2) { self.paste() }
        }
      }
    }
  }

  func paste() {
    // Chrome prefixes its HTML flavor with this meta tag on macOS.
    let pasteboard = NSPasteboard.general
    pasteboard.clearContents()
    pasteboard.setString("<meta charset='utf-8'>\(envelope)", forType: .html)
    pasteboard.setString(envelope, forType: .string)
    window.makeFirstResponder(web)
    evaluate("document.activeElement?.blur?.(); return true") { _ in
      NSApp.sendAction(NSSelectorFromString("paste:"), to: self.web, from: nil)
      self.waitFor("return window.openPencil.getStore().graph.getChildren(window.openPencil.getStore().state.currentPageId).length > 0", attempts: 40) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { self.report() }
      }
    }
  }

  func report() {
    evaluate(summarizeGraph) { value in
      print(value as? String ?? "no summary")
      print("{\"readTextCalls\":\(self.readTextCalls)}")
      guard let path = self.screenshotPath else { return self.finish(0) }
      self.web.takeSnapshot(with: nil) { image, _ in
        if let image, let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff),
           let png = bitmap.representation(using: .png, properties: [:]) {
          try? png.write(to: URL(fileURLWithPath: path))
        }
        self.finish(0)
      }
    }
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let harness = Harness()
harness.envelope = envelope
harness.screenshotPath = screenshotPath
harness.savePasteboard()
let configuration = WKWebViewConfiguration()
configuration.userContentController.addScriptMessageHandler(harness, contentWorld: .page, name: "ipc")
configuration.userContentController.addUserScript(WKUserScript(source: tauriShim, injectionTime: .atDocumentStart, forMainFrameOnly: true))
harness.window = NSWindow(contentRect: NSRect(x: -3000, y: -3000, width: 1280, height: 860), styleMask: [.titled], backing: .buffered, defer: false)
harness.web = WKWebView(frame: harness.window.contentView!.bounds, configuration: configuration)
harness.web.navigationDelegate = harness
harness.window.contentView!.addSubview(harness.web)
harness.window.orderFrontRegardless()
harness.window.makeKey()
harness.web.load(URLRequest(url: editorURL))
DispatchQueue.main.asyncAfter(deadline: .now() + 120) { print("timeout"); harness.finish(1) }
app.run()
