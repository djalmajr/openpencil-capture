import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convertCaptureToTree } from "../src/convert-capture.mjs";
import { useBrowser } from "./support/browser.mjs";

const captureHtml = useBrowser();
setDefaultTimeout(20_000);

const leaked = (capture, values) => values.filter((value) => JSON.stringify(capture).includes(value));

const texts = (tree) => {
  const found = [];
  const visit = (node) => { if (node.type === "text") found.push(node.content); node.children?.forEach(visit); };
  visit(tree.root);
  return found;
};

describe("what a capture may contain", () => {
  // Mutation captured: dropping the checkVisibility() skip records the collapsed text.
  test("leaves out content the page collapses or hides", async () => {
    const capture = await captureHtml(`<div id="root">
      <p>shown</p>
      <details><summary>Summary</summary><p>closed-secret</p></details>
      <div hidden="until-found">until-found-secret</div>
      <div style="content-visibility:hidden">content-visibility-secret</div>
      <div style="display:none">display-secret</div>
      <div style="opacity:0"><span>opacity-secret</span><input value="opacity-input-secret"></div>
      <span style="visibility:hidden">visibility-secret</span>
    </div>`);
    expect(leaked(capture, ["closed-secret", "until-found-secret", "content-visibility-secret", "display-secret", "opacity-secret", "opacity-input-secret", "visibility-secret"])).toEqual([]);
    expect(texts(convertCaptureToTree(capture))).toEqual(["shown", "Summary"]);
  });

  // Mutation captured: ignoring the clip chain keeps values that are moved or clipped out of sight.
  test("keeps the values of controls nobody can see out of the capture", async () => {
    const capture = await captureHtml(`<form id="root" style="position:relative;width:300px">
      <input value="visible-value">
      <input style="position:absolute;left:-9999px" value="offscreen-secret">
      <div style="height:0;overflow:hidden"><input value="collapsed-secret"></div>
      <div style="height:30px;overflow:auto"><div style="height:200px"></div><input value="scrolled-secret"></div>
      <div style="width:1px;height:1px;overflow:hidden;position:absolute"><input value="tiny-secret"></div>
    </form>`);
    expect(leaked(capture, ["offscreen-secret", "collapsed-secret", "scrolled-secret", "tiny-secret"])).toEqual([]);
    expect(leaked(capture, ["visible-value"])).toEqual(["visible-value"]);
  });

  test("refuses a selection the page does not render", async () => {
    await expect(captureHtml(`<details><summary>s</summary><p id="root">inside</p></details>`)).rejects.toThrow("not visible");
  });

  test("records the blend mode an overlay paints with", async () => {
    const capture = await captureHtml(`<div id="root"><div style="width:20px;height:20px;background:red;mix-blend-mode:multiply"></div></div>`);
    expect(capture.nodes[1].styles.mixBlendMode).toBe("multiply");
  });
});
