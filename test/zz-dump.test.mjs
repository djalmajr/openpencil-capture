import { test } from "bun:test";
import { writeFileSync } from "node:fs";
import { useBrowser } from "./support/browser.mjs";
import { renderInEditor } from "./support/render.mjs";
const captureHtml = useBrowser();
const box = (style, inner = "") => `<div id="root" style="width:160px;height:96px;${style}">${inner}</div>`;
const cases = {
  shadow: `<script>customElements.define("x-card", class extends HTMLElement { constructor() { super(); this.attachShadow({mode:"open"}).innerHTML = '<div style="position:absolute;margin:20px 0 0 60px;width:80px;height:50px;background:rgb(240, 90, 30)"></div><div style="padding:8px"><slot></slot></div>'; } });</script>` + box("background:rgb(255, 255, 255)", `<x-card style="display:block;width:160px;height:96px"><span style="display:block;width:40px;height:40px;background:rgb(30, 160, 90)"></span></x-card>`),
  frame: box("background:rgb(255, 255, 255)", `<iframe srcdoc="<body style='margin:0;background:rgb(250, 240, 200)'><div style='margin:10px;width:60px;height:30px;background:rgb(200, 40, 40)'></div></body>" style="display:block;width:140px;height:76px;margin:6px;border:4px solid rgb(40, 40, 40)"></iframe>`),
  use: `<svg style="display:none"><symbol id="mark" viewBox="0 0 24 24"><path d="M2 2 H22 V12 H2 Z" fill="currentColor"/><circle cx="12" cy="18" r="4" fill="rgb(255, 160, 0)"/></symbol></svg>` + box("background:rgb(255, 255, 255);color:rgb(40, 90, 220)", `<svg width="96" height="96" style="display:block;margin-left:32px"><use href="#mark"/></svg>`),
};
test("dump", async () => {
  for (const [name, html] of Object.entries(cases)) {
    const {capture, png} = await captureHtml(html, "#root", {screenshot:true});
    const r = await renderInEditor(capture);
    writeFileSync(`/tmp/opc-probe/${name}-chrome.png`, png); writeFileSync(`/tmp/opc-probe/${name}-editor.png`, await r.render());
    console.log("##", name, capture.nodes.map((n) => `${n.path}:${n.tag}${n.synthetic ? "*" : ""}[${Math.round(n.rect.x)},${Math.round(n.rect.y)},${Math.round(n.rect.width)},${Math.round(n.rect.height)}]${n.styles.fill && n.namespace?.includes("svg") ? " fill=" + n.styles.fill : ""}`).join(" "));
    const show = (node, depth = 0) => [`${"  ".repeat(depth)}${node.type} ${node.name} ${node.x},${node.y} ${node.width}x${node.height} ${JSON.stringify(node.fill || "")}`.slice(0, 160), ...(node.children || []).flatMap((child) => show(child, depth + 1))];
    console.log(show(r.tree.root).join("\n"));
  }
}, 60000);
