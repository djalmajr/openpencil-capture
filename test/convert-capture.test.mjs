import { describe, expect, test } from "bun:test";
import { convertCaptureToTree, cssBackgroundToFill, cssColorToHex } from "../src/convert-capture.mjs";

const rootStyles = { backgroundColor:"oklch(1 0 0)", borderTopColor:"oklch(0.93 0.007 106.5)", borderTopLeftRadius:"8px", borderTopRightRadius:"8px", borderBottomRightRadius:"8px", borderBottomLeftRadius:"8px", opacity:"1" };

// A capture of `elements`, the first one the root; each is [path, tag, rect, styles, fields].
const ir = (...elements) => ({format:"openpencil-capture-ir", version:1, rootPath:"0", label:"Fixture", source:{url:"https://example.test/"}, nodes:elements.map(([path, tag, rect, styles = {}, fields = {}]) => ({
  path, parentPath:path.includes(".") ? path.slice(0, path.lastIndexOf(".")) : null, tag, name:tag, text:null, textRuns:[],
  rect:{x:rect[0], y:rect[1], width:rect[2], height:rect[3]}, attributes:{}, ...fields, styles:{...rootStyles, ...styles},
}))});

describe("cssColorToHex", () => {
  test("converts shadcn OKLCH and transparent colors", () => {
    expect(cssColorToHex("oklch(1 0 0)")).toBe("#FFFFFF");
    expect(cssColorToHex("oklch(0.153 0.006 107.1)")).toBe("#0C0C09");
    expect(cssColorToHex("rgba(0, 0, 0, 0)")).toBeNull();
    expect(cssColorToHex("none")).toBeNull();
    expect(cssColorToHex("lab(66.9756 -58.27 19.5419)")).toBe("#00BC7D");
    expect(cssColorToHex("lab(76.3898 14.5258 98.4589)")).toBe("#F0B100");
  });

  test("reads a shadow painted in a color() space", () => {
    const tree = convertCaptureToTree(ir(["0", "div", [0, 0, 100, 50], {boxShadow:"color(srgb 1 0 0) 0px 4px 8px 0px"}]));
    expect(tree.root.effect).toMatchObject({shadowType:"outer", color:"#FF0000", blur:8});
  });
});

describe("convertCaptureToTree", () => {
  test("turns CSS filters into effects and layer opacity", () => {
    const {root} = convertCaptureToTree(ir(["0", "div", [0, 0, 80, 40], {filter:"blur(4px) drop-shadow(rgb(0, 0, 0) 2px 3px 6px) opacity(0.5)", backdropFilter:"blur(12px) saturate(1.5)", opacity:"0.8"}]));
    expect(root.effect).toEqual([
      {type:"blur", kind:"layer", sigma:4},
      {type:"shadow", shadowType:"outer", offset:{x:2, y:3}, blur:6, spread:0, color:"#000000"},
      {type:"blur", kind:"background", sigma:12},
    ]);
    expect(root.opacity).toBe(0.4);
  });

  test("bakes an image's color filters into its pixels and keeps grayscale editable", () => {
    const tree = convertCaptureToTree(ir(["0", "div", [0, 0, 80, 40]], ["0.0", "img", [0, 0, 80, 40], {filter:"sepia(0.8) grayscale(1)"}, {attributes:{currentSrc:"https://example.test/a.png", effectiveFilter:"sepia(0.8) grayscale(1)"}}]));
    const image = tree.root.children[0];
    expect(image.children[0].fill).toMatchObject({type:"image", filter:"sepia(0.8)"});
    expect(image.children[1].name).toContain("Grayscale");
  });

  test("resolves percentage and elliptical radii against the box", () => {
    const radius = (value, width = 80, height = 40) => convertCaptureToTree(ir(["0", "div", [0, 0, width, height], {
      borderTopLeftRadius:value, borderTopRightRadius:value, borderBottomRightRadius:value, borderBottomLeftRadius:value,
    }])).root.cornerRadius;
    expect(radius("50%")).toBe(20);
    expect(radius("10px 25%")).toBe(10);
    expect(radius("25% 40%", 100, 100)).toBe(25);
  });

  // CSS shrinks every corner by the factor that stops the largest pair overlapping.
  test("shrinks radii that would overlap, as CSS does", () => {
    const pill = convertCaptureToTree(ir(["0", "div", [0, 0, 120, 40], {borderTopLeftRadius:"9999px", borderTopRightRadius:"9999px", borderBottomRightRadius:"9999px", borderBottomLeftRadius:"9999px"}]));
    expect(pill.root.cornerRadius).toBe(20);
    const tab = convertCaptureToTree(ir(["0", "div", [0, 0, 100, 40], {borderTopLeftRadius:"60px", borderTopRightRadius:"60px", borderBottomRightRadius:"0px", borderBottomLeftRadius:"0px"}]));
    expect(tab.root.cornerRadius).toEqual([40, 40, 0, 0]);
  });

  test("clips scrolling containers like hidden ones", () => {
    const clip = (styles) => convertCaptureToTree(ir(["0", "div", [0, 0, 80, 40]], ["0.0", "div", [0, 0, 80, 40], styles])).root.children[0].clip;
    expect(clip({overflowX:"auto", overflowY:"auto"})).toBe(true);
    expect(clip({overflow:"visible scroll"})).toBe(true);
    expect(clip({overflowX:"visible", overflowY:"visible"})).toBeUndefined();
  });

  test("preserves intentional clipping on the captured root", () => {
    const capture = {format:"openpencil-capture-ir",version:1,rootPath:"0",label:"Clipped shell",source:{},nodes:[
      {path:"0",parentPath:null,tag:"div",name:"root",text:null,rect:{x:0,y:0,width:320,height:200},attributes:{},styles:{...rootStyles,overflow:"hidden"}},
      {path:"0.0",parentPath:"0",tag:"div",name:"tall",text:null,rect:{x:0,y:0,width:100,height:400},attributes:{},styles:{...rootStyles,backgroundColor:"transparent"}}
    ]};
    expect(convertCaptureToTree(capture).root).toMatchObject({type:"frame",clip:true,width:320,height:200});
  });

  test("keeps transparent buttons bounded and maps unsupported Geist Variable text", () => {
    const capture = {format:"openpencil-capture-ir",version:1,rootPath:"0",label:"Ghost button",source:{},nodes:[
      {path:"0",parentPath:null,tag:"div",name:"root",text:null,rect:{x:0,y:0,width:120,height:64},attributes:{},styles:rootStyles},
      {path:"0.0",parentPath:"0",tag:"button",name:"button",text:"Ghost",textRect:{x:30,y:22,width:40,height:20},textRuns:[{text:"Ghost",rect:{x:30,y:22,width:40,height:20}}],rect:{x:20,y:16,width:80,height:32},attributes:{},styles:{...rootStyles,backgroundColor:"transparent",borderTopWidth:"0px",borderRightWidth:"0px",borderBottomWidth:"0px",borderLeftWidth:"0px",boxShadow:"none",color:"rgb(10,10,10)",fontFamily:"Geist Variable, sans-serif",fontSize:"14px",fontWeight:"500",lineHeight:"20px",textAlign:"center",textTransform:"none"}}
    ]};
    const button = convertCaptureToTree(capture).root.children[0];
    expect(button).toMatchObject({type:"frame",layout:"none",x:20,y:16,width:80,height:32});
    expect(button.children[0]).toMatchObject({type:"text",content:"Ghost",fontFamily:"Inter"});
  });

  test("creates editable absolute layers", () => {
    const capture = { format:"openpencil-capture-ir", version:1, rootPath:"0", label:"Example card", source:{}, nodes:[
      { path:"0", parentPath:null, tag:"div", name:"card", text:null, rect:{x:0,y:0,width:320,height:200}, attributes:{}, styles:rootStyles },
      { path:"0.0", parentPath:"0", tag:"div", name:"title", text:"Hello", rect:{x:16,y:16,width:288,height:24}, attributes:{}, styles:{backgroundColor:"transparent",color:"rgb(0, 0, 0)",opacity:"1",fontFamily:"Noto Sans, sans-serif",fontSize:"16px",fontWeight:"600",fontStyle:"normal",lineHeight:"24px",textAlign:"start",textTransform:"none"} },
    ] };
    const result = convertCaptureToTree(capture);
    expect(result.root).toMatchObject({ type:"frame", name:"Captured · Example card", clip:false });
    expect(result.root.children[0]).toMatchObject({ type:"frame", name:"Div · title", layout:"none", x:16, y:16, width:288, height:24 });
    expect(result.root.children[0].children[0]).toMatchObject({ type:"text", content:"Hello", layoutPosition:"absolute", x:0, y:0 });
  });

  test("converts SVG primitives and visible form values", () => {
    const styles = { ...rootStyles, fill:"rgb(217, 145, 23)", stroke:"none", strokeWidth:"0", color:"rgb(10, 10, 10)", fontFamily:"Noto Sans", fontSize:"14px", fontWeight:"400", fontStyle:"normal", lineHeight:"20px", textAlign:"start", textTransform:"none" };
    const capture = { format:"openpencil-capture-ir", version:1, rootPath:"0", label:"Chart", source:{}, nodes:[
      { path:"0", parentPath:null, tag:"div", name:"card", text:null, rect:{x:0,y:0,width:320,height:200}, attributes:{}, styles:rootStyles },
      { path:"0.0", parentPath:"0", tag:"rect", namespace:"http://www.w3.org/2000/svg", name:"rect", text:null, rect:{x:20,y:20,width:40,height:120}, attributes:{rx:"4"}, styles },
      { path:"0.1", parentPath:"0", tag:"input", name:"input", text:null, rect:{x:80,y:20,width:200,height:32}, attributes:{value:"VOO",placeholder:"Search"}, styles:{...styles,backgroundColor:"rgb(255, 255, 255)"} },
    ] };
    const result = convertCaptureToTree(capture);
    expect(result.stats).toMatchObject({ svgGraphics:1, controls:1 });
    expect(result.root.children).toContainEqual(expect.objectContaining({ type:"rectangle", x:20, y:20, width:40, height:120 }));
    expect(result.root.children[1].children).toContainEqual(expect.objectContaining({ type:"text", content:"VOO" }));
  });

  test("keeps nested SVG paths in the SVG viewBox instead of page coordinates", () => {
    const styles = { ...rootStyles, backgroundColor:"transparent", fill:"none", stroke:"rgb(12, 12, 9)", strokeWidth:"2px" };
    const capture = { format:"openpencil-capture-ir", version:1, rootPath:"0", label:"Icon", source:{}, nodes:[
      { path:"0", parentPath:null, tag:"div", name:"root", text:null, rect:{x:0,y:0,width:200,height:100}, attributes:{}, styles:rootStyles },
      { path:"0.0", parentPath:"0", tag:"svg", namespace:"http://www.w3.org/2000/svg", name:"icon", text:null, rect:{x:140,y:20,width:16,height:16}, attributes:{viewBox:"0 0 24 24"}, styles },
      { path:"0.0.0", parentPath:"0.0", tag:"g", namespace:"http://www.w3.org/2000/svg", name:"group", text:null, rect:{x:142,y:22,width:12,height:12}, attributes:{}, styles },
      { path:"0.0.0.0", parentPath:"0.0.0", tag:"path", namespace:"http://www.w3.org/2000/svg", name:"path", text:null, rect:{x:142,y:22,width:12,height:12}, attributes:{d:"M 2 2 L 22 22"}, styles },
    ] };
    const svg = convertCaptureToTree(capture).root.children[0];
    const group = svg.children[0];
    const path = group.children[0];
    expect(svg).toMatchObject({type:"group",x:140,y:20});
    expect(group).toMatchObject({type:"group",x:0,y:0});
    expect(path).toMatchObject({x:0,y:0,width:16,height:16,viewBox:[0,0,24,24]});
  });

  test("keeps zero-dimension SVG strokes and positions SVG text", () => {
    const svgStyles = { ...rootStyles, backgroundColor:"transparent", overflow:"hidden", fill:"none", fillOpacity:"1", stroke:"rgb(12, 12, 9)", strokeOpacity:"1", strokeWidth:"2px", color:"rgb(12, 12, 9)", fontFamily:"Noto Sans", fontSize:"12px", fontWeight:"400", fontStyle:"normal", lineHeight:"16px", textAlign:"start", textTransform:"none" };
    const capture = { format:"openpencil-capture-ir", version:1, rootPath:"0", label:"SVG labels", source:{}, nodes:[
      { path:"0", parentPath:null, tag:"div", name:"root", text:null, rect:{x:0,y:0,width:200,height:100}, attributes:{}, styles:rootStyles },
      { path:"0.0", parentPath:"0", tag:"svg", namespace:"http://www.w3.org/2000/svg", name:"chart", text:null, rect:{x:20,y:20,width:160,height:60}, attributes:{viewBox:"0 0 160 60"}, styles:svgStyles },
      { path:"0.0.0", parentPath:"0.0", tag:"path", namespace:"http://www.w3.org/2000/svg", name:"horizontal", text:null, rect:{x:30,y:50,width:40,height:0}, attributes:{d:"M 10 30 H 50"}, styles:svgStyles },
      { path:"0.0.1", parentPath:"0.0", tag:"text", namespace:"http://www.w3.org/2000/svg", name:"axis-label", text:"Jan", textRect:{x:42,y:62,width:18,height:16}, textRuns:[{text:"Jan",rect:{x:42,y:62,width:18,height:16}}], rect:{x:42,y:62,width:18,height:16}, attributes:{}, styles:{...svgStyles,fill:"rgb(12, 12, 9)",stroke:"none"} },
    ] };
    const svg = convertCaptureToTree(capture).root.children[0];
    expect(svg).toMatchObject({type:"frame",x:20,y:20,width:160,height:60,clip:true});
    expect(svg.children[0]).toMatchObject({type:"path",width:160,height:60,viewBox:[0,0,160,60]});
    expect(svg.children[1]).toMatchObject({x:22,y:42});
    expect(svg.children[1].children[0]).toMatchObject({content:"Jan",textGrowth:"auto",x:0,y:0});
  });

  test("positions SVG text against the SVG viewport when its g wrapper is expanded", () => {
    const styles = {...rootStyles,backgroundColor:"transparent",fill:"rgb(12, 12, 9)",stroke:"none",color:"rgb(12, 12, 9)",fontFamily:"Noto Sans",fontSize:"24px",fontWeight:"700",lineHeight:"32px",textAlign:"start",textTransform:"none"};
    const capture = {format:"openpencil-capture-ir",version:1,rootPath:"0",label:"Donut",source:{},nodes:[
      {path:"0",parentPath:null,tag:"div",name:"root",text:null,rect:{x:0,y:0,width:240,height:240},attributes:{},styles:rootStyles},
      {path:"0.0",parentPath:"0",tag:"svg",namespace:"http://www.w3.org/2000/svg",name:"chart",text:null,rect:{x:20,y:20,width:190,height:190},attributes:{viewBox:"0 0 190 190"},styles},
      {path:"0.0.0",parentPath:"0.0",tag:"g",namespace:"http://www.w3.org/2000/svg",name:"layer",text:null,rect:{x:50,y:40,width:130,height:120},attributes:{},styles},
      {path:"0.0.0.0",parentPath:"0.0.0",tag:"text",namespace:"http://www.w3.org/2000/svg",name:"center",text:null,rect:{x:94,y:80,width:42,height:47},attributes:{x:"95",y:"95"},styles},
      {path:"0.0.0.0.0",parentPath:"0.0.0.0",tag:"tspan",namespace:"http://www.w3.org/2000/svg",name:"935",text:"935",textRect:{x:94,y:80,width:42,height:33},textRuns:[{text:"935",rect:{x:94,y:80,width:42,height:33}}],rect:{x:94,y:80,width:42,height:33},attributes:{x:"95",y:"79"},styles},
    ]};
    const text = convertCaptureToTree(capture).root.children[0].children[0].children[0];
    expect(text).toMatchObject({x:74,y:60});
  });

  test("scales SVG strokes and converts progress circle dash arrays", () => {
    const styles = { ...rootStyles, backgroundColor:"transparent", fill:"none", fillOpacity:"1", stroke:"rgb(187, 77, 0)", strokeOpacity:"1", strokeWidth:"12px", strokeDasharray:"179.822px, 267.035px", opacity:"0.2" };
    const capture = { format:"openpencil-capture-ir", version:1, rootPath:"0", label:"Progress", source:{}, nodes:[
      { path:"0", parentPath:null, tag:"div", name:"root", text:null, rect:{x:0,y:0,width:40,height:40}, attributes:{}, styles:rootStyles },
      { path:"0.0", parentPath:"0", tag:"svg", namespace:"http://www.w3.org/2000/svg", name:"progress", text:null, rect:{x:12,y:12,width:16,height:16}, attributes:{viewBox:"0 0 100 100"}, styles },
      { path:"0.0.0", parentPath:"0.0", tag:"circle", namespace:"http://www.w3.org/2000/svg", name:"value", text:null, rect:{x:13.2,y:13.2,width:13.6,height:13.6}, attributes:{cx:"50",cy:"50",r:"42.5"}, styles },
    ] };
    const circle = convertCaptureToTree(capture).root.children[0].children[0];
    expect(circle).toMatchObject({type:"path",fill:"#00000000",strokeWidth:1.92,opacity:0.2,viewBox:[0,0,13.6,13.6]});
    expect(circle.geometry).toMatch(/^M 13\.6 6\.8 A 6\.8 6\.8 0 1 1 /);
  });

  test("keeps a dashed circle dashed instead of reading it as progress", () => {
    const styles = {...rootStyles, backgroundColor:"transparent", fill:"none", stroke:"rgb(0, 0, 0)", strokeWidth:"2px", strokeDasharray:"6px, 4px", strokeLinecap:"butt"};
    const circle = convertCaptureToTree(ir(["0", "div", [0, 0, 40, 40]], ["0.0", "svg", [0, 0, 40, 40], styles, {namespace:"http://www.w3.org/2000/svg", attributes:{viewBox:"0 0 40 40"}}],
      ["0.0.0", "circle", [2, 2, 36, 36], styles, {namespace:"http://www.w3.org/2000/svg", attributes:{cx:"20", cy:"20", r:"18"}}])).root.children[0].children[0];
    expect(circle).toMatchObject({type:"ellipse", dashPattern:[6, 4], strokeLinecap:"butt"});
  });

  test("dashes and dots borders the way Chromium draws them", () => {
    const border = (style, width) => convertCaptureToTree(ir(["0", "div", [0, 0, 80, 40], Object.fromEntries(["Top", "Right", "Bottom", "Left"].flatMap((side) => [[`border${side}Width`, `${width}px`], [`border${side}Style`, style], [`border${side}Color`, "rgb(0, 0, 0)"]]))])).root;
    expect(border("dashed", 2).dashPattern).toEqual([6, 4]);
    expect(border("dashed", 4).dashPattern).toEqual([8, 4]);
    expect(border("dotted", 2).dashPattern).toEqual([2, 2]);
    expect(border("solid", 2).dashPattern).toBeUndefined();
    expect(border("hidden", 2).stroke).toBeUndefined();
  });

  test("turns shadcn shadow rings into editable card strokes", () => {
    const styles = {...rootStyles,backgroundColor:"rgb(255, 255, 255)",boxShadow:"rgba(0, 0, 0, 0) 0px 0px 0px 0px, oklab(0.153 -0.00176424 0.00573476 / 0.1) 0px 0px 0px 1px",borderTopWidth:"0px",borderRightWidth:"0px",borderBottomWidth:"0px",borderLeftWidth:"0px"};
    const capture = {format:"openpencil-capture-ir",version:1,rootPath:"0",label:"Card",source:{},nodes:[
      {path:"0",parentPath:null,tag:"div",name:"card",text:null,rect:{x:0,y:0,width:320,height:200},attributes:{},styles},
    ]};
    expect(convertCaptureToTree(capture).root).toMatchObject({stroke:"#0C0C091A",strokeWidth:1,strokeAlignment:"inner"});
  });

  test("uses placeholder pseudo color and native control padding", () => {
    const styles = {...rootStyles,backgroundColor:"rgb(255, 255, 255)",color:"rgb(12, 12, 9)",fontFamily:"Noto Sans",fontSize:"14px",fontWeight:"400",fontStyle:"normal",lineHeight:"20px",paddingTop:"8px",paddingLeft:"10px"};
    const capture = {format:"openpencil-capture-ir",version:1,rootPath:"0",label:"Form",source:{},nodes:[
      {path:"0",parentPath:null,tag:"div",name:"root",text:null,rect:{x:0,y:0,width:320,height:100},attributes:{},styles:rootStyles},
      {path:"0.0",parentPath:"0",tag:"textarea",name:"bio",text:null,rect:{x:20,y:12,width:280,height:64},attributes:{placeholder:"Tell us more",placeholderColor:"oklch(0.58 0.031 107.3)",placeholderOpacity:"1"},styles},
    ]};
    const value = convertCaptureToTree(capture).root.children[0].children[0];
    expect(value).toMatchObject({content:"Tell us more",x:10,y:8,fill:"#7C7C67"});
  });

  test("preserves anchor underline and href", () => {
    const styles = {...rootStyles,backgroundColor:"transparent",color:"rgb(12, 12, 9)",fontFamily:"Noto Sans",fontSize:"14px",fontWeight:"400",fontStyle:"normal",lineHeight:"20px",textAlign:"start",textTransform:"none",textDecorationLine:"underline"};
    const capture = {format:"openpencil-capture-ir",version:1,rootPath:"0",label:"Link",source:{},nodes:[
      {path:"0",parentPath:null,tag:"div",name:"root",text:null,rect:{x:0,y:0,width:200,height:40},attributes:{},styles:rootStyles},
      {path:"0.0",parentPath:"0",tag:"a",name:"email settings",text:"email settings",textRect:{x:10,y:10,width:92,height:20},textRuns:[{text:"email settings",rect:{x:10,y:10,width:92,height:20}}],rect:{x:10,y:10,width:92,height:20},attributes:{href:"https://example.com/settings"},styles},
    ]};
    const anchor = convertCaptureToTree(capture).root.children[0];
    expect(anchor.children[0]).toMatchObject({content:"email settings",underline:true,href:"https://example.com/settings",metadata:{type:"openpencil-capture-link",href:"https://example.com/settings"}});
    expect(anchor.children[1]).toMatchObject({type:"frame",name:"A · email settings · Underline",x:0,y:19,width:92,height:1,fill:"#0C0C09",metadata:{type:"openpencil-capture-link-underline",href:"https://example.com/settings"}});
  });

  test("drops zero-geometry control shadows instead of keeping meaningless layers", () => {
    const styles = {...rootStyles,overflow:"clip",backgroundColor:"transparent",boxShadow:"rgba(0, 0, 0, 0) 0px 0px 0px 0px, oklch(0.153 0.006 107.1) 0px 0px 0px 0px"};
    const capture = {format:"openpencil-capture-ir",version:1,rootPath:"0",label:"Input group",source:{},nodes:[
      {path:"0",parentPath:null,tag:"div",name:"root",text:null,rect:{x:0,y:0,width:320,height:40},attributes:{},styles:rootStyles},
      {path:"0.0",parentPath:"0",tag:"input",name:"input-group-control",text:null,rect:{x:1,y:4,width:280,height:32},attributes:{placeholder:"Name",placeholderColor:"rgb(124,124,103)",placeholderOpacity:"1"},styles},
    ]};
    const input = convertCaptureToTree(capture).root.children[0];
    expect(input.type).toBe("frame");
    expect(input).not.toHaveProperty("effect");
    expect(input).not.toHaveProperty("stroke");
  });

  test("keeps visible SVG descendants behind zero-sized responsive wrappers", () => {
    const styles = { ...rootStyles, backgroundColor:"transparent", fill:"oklch(0.769 0.188 70.08)", stroke:"none", strokeWidth:"0" };
    const capture = { format:"openpencil-capture-ir", version:1, rootPath:"0", label:"Responsive chart", source:{}, nodes:[
      { path:"0", parentPath:null, tag:"div", name:"root", text:null, rect:{x:0,y:0,width:400,height:240}, attributes:{}, styles:rootStyles },
      { path:"0.0", parentPath:"0", tag:"div", name:"responsive-container", text:null, rect:{x:0,y:0,width:0,height:0}, attributes:{}, styles },
      { path:"0.0.0", parentPath:"0.0", tag:"svg", namespace:"http://www.w3.org/2000/svg", name:"chart", text:null, rect:{x:40,y:20,width:320,height:180}, attributes:{viewBox:"0 0 320 180"}, styles },
      { path:"0.0.0.0", parentPath:"0.0.0", tag:"path", namespace:"http://www.w3.org/2000/svg", name:"bar", text:null, rect:{x:60,y:80,width:24,height:100}, attributes:{d:"M20 60 L44 60 L44 160 L20 160 Z"}, styles },
    ] };
    const result = convertCaptureToTree(capture);
    const bridge = result.root.children[0];
    expect(result.stats.svgGraphics).toBe(1);
    expect(bridge).toMatchObject({type:"group",x:0,y:0});
    expect(bridge.children[0]).toMatchObject({type:"group",x:40,y:20});
    expect(bridge.children[0].children[0]).toMatchObject({type:"path",fill:"#FE9A00",viewBox:[0,0,320,180]});
  });

  test("preserves DOM hierarchy with coordinates relative to each parent", () => {
    const styles = { ...rootStyles, backgroundColor:"transparent", color:"rgb(0, 0, 0)", fontSize:"14px", lineHeight:"20px" };
    const capture = { format:"openpencil-capture-ir", version:1, rootPath:"0", label:"Nested", source:{}, nodes:[
      { path:"0", parentPath:null, tag:"main", name:"main", text:null, rect:{x:0,y:0,width:400,height:300}, attributes:{}, styles:rootStyles },
      { path:"0.0", parentPath:"0", tag:"section", name:"Account", text:null, rect:{x:40,y:30,width:300,height:200}, attributes:{}, styles },
      { path:"0.0.0", parentPath:"0.0", tag:"p", name:"Balance", text:"Balance", textRect:{x:64,y:54,width:80,height:20}, rect:{x:60,y:50,width:260,height:32}, attributes:{}, styles },
    ] };
    const result = convertCaptureToTree(capture);
    const section = result.root.children[0];
    const paragraph = section.children[0];
    expect(section).toMatchObject({ type:"frame", layout:"none", x:40, y:30, width:300, height:200 });
    expect(paragraph).toMatchObject({ type:"frame", layout:"none", x:20, y:20, width:260, height:32 });
    expect(paragraph.children[0]).toMatchObject({ type:"text", x:4, y:4, width:83.2, height:20, textGrowth:"fixed-width-height" });
  });

  test("keeps transparent semantic wrappers bounded without clipping overflowing text", () => {
    const styles = { ...rootStyles, backgroundColor:"transparent", color:"rgb(0, 0, 0)", fontSize:"14px", lineHeight:"20px" };
    const capture = { format:"openpencil-capture-ir", version:1, rootPath:"0", label:"Overflow", source:{}, nodes:[
      { path:"0", parentPath:null, tag:"div", name:"root", text:null, rect:{x:0,y:0,width:100,height:100}, attributes:{}, styles:rootStyles },
      { path:"0.0", parentPath:"0", tag:"label", name:"Label", text:"Label", textRect:{x:10,y:7,width:40,height:19}, rect:{x:10,y:10,width:60,height:14}, attributes:{}, styles },
    ] };
    const label = convertCaptureToTree(capture).root.children[0];
    expect(label).toMatchObject({type:"frame",layout:"none",x:10,y:10,width:60,height:14});
    expect(label).not.toHaveProperty("clip");
    expect(label.children[0]).toMatchObject({x:0,y:-3,width:42,height:19,textGrowth:"fixed-width-height"});
  });

  test("drops one-pixel accessibility controls while keeping their visible replacement", () => {
    const styles = { ...rootStyles, backgroundColor:"transparent" };
    const capture = { format:"openpencil-capture-ir", version:1, rootPath:"0", label:"Hidden", source:{}, nodes:[
      { path:"0", parentPath:null, tag:"div", name:"root", text:null, rect:{x:0,y:0,width:100,height:100}, attributes:{}, styles:rootStyles },
      { path:"0.0", parentPath:"0", tag:"input", name:"native", text:null, rect:{x:-999,y:-999,width:1,height:1}, attributes:{type:"checkbox"}, styles },
      { path:"0.1", parentPath:"0", tag:"span", name:"checkbox", text:null, rect:{x:10,y:10,width:16,height:16}, attributes:{}, styles },
    ] };
    const result = convertCaptureToTree(capture);
    expect(result.root.children).toHaveLength(1);
    expect(result.stats.skipped).toBe(1);
  });

  test("drops sr-only semantic text instead of rendering it over visible content", () => {
    const styles = { ...rootStyles, backgroundColor:"transparent", color:"rgb(0, 0, 0)", fontFamily:"Noto Sans", fontSize:"14px", fontWeight:"400", lineHeight:"20px", textAlign:"start", textTransform:"none" };
    const capture = { format:"openpencil-capture-ir", version:1, rootPath:"0", label:"Accessible field", source:{}, nodes:[
      { path:"0", parentPath:null, tag:"div", name:"root", text:null, rect:{x:0,y:0,width:320,height:120}, attributes:{}, styles:rootStyles },
      { path:"0.0", parentPath:"0", tag:"legend", name:"field-legend", text:"Private activity", textRect:{x:12,y:12,width:102,height:20}, rect:{x:11,y:11,width:1,height:1}, attributes:{}, styles:{...styles,position:"absolute",overflow:"hidden"} },
      { path:"0.1", parentPath:"0", tag:"label", name:"field-label", text:"Hide activity", textRect:{x:32,y:24,width:82,height:20}, rect:{x:32,y:24,width:82,height:20}, attributes:{}, styles },
    ] };
    const result = convertCaptureToTree(capture);
    expect(result.root.children).toHaveLength(1);
    expect(result.root.children[0].children[0]).toMatchObject({content:"Hide activity"});
    expect(result.stats.skipped).toBe(1);
  });

  test("keeps intrinsically-sized single-line text unwrapped", () => {
    const styles = { ...rootStyles, backgroundColor:"transparent", color:"rgb(0, 0, 0)", fontFamily:"Noto Sans", fontSize:"14px", fontWeight:"500", lineHeight:"20px", textAlign:"center", textTransform:"none" };
    const capture = { format:"openpencil-capture-ir", version:1, rootPath:"0", label:"Empty state", source:{}, nodes:[
      { path:"0", parentPath:null, tag:"div", name:"root", text:null, rect:{x:0,y:0,width:320,height:120}, attributes:{}, styles:rootStyles },
      { path:"0.0", parentPath:"0", tag:"div", name:"empty-title", text:"404 - Not Found", textRect:{x:109,y:20,width:102,height:20}, rect:{x:109,y:20,width:102,height:20}, attributes:{}, styles },
    ] };
    const text = convertCaptureToTree(capture).root.children[0].children[0];
    expect(text).toMatchObject({textGrowth:"auto",x:0,y:0});
    expect(text).not.toHaveProperty("width");
    expect(text).not.toHaveProperty("height");
  });

  test("preserves separate editable direct-text line runs", () => {
    const styles = { ...rootStyles, backgroundColor:"transparent", color:"rgb(0, 0, 0)", fontFamily:"Noto Sans", fontSize:"14px", fontWeight:"400", lineHeight:"20px", textAlign:"start", textTransform:"none" };
    const capture = { format:"openpencil-capture-ir", version:1, rootPath:"0", label:"Inline text", source:{}, nodes:[
      { path:"0", parentPath:null, tag:"div", name:"root", text:null, rect:{x:0,y:0,width:320,height:120}, attributes:{}, styles:rootStyles },
      { path:"0.0", parentPath:"0", tag:"p", name:"description", text:"before after", textRect:{x:20,y:20,width:160,height:40}, textRuns:[
        {text:"before",rect:{x:20,y:20,width:42,height:20}},
        {text:"after",rect:{x:88,y:40,width:34,height:20}},
      ], rect:{x:20,y:20,width:280,height:40}, attributes:{}, styles },
    ] };
    const paragraph = convertCaptureToTree(capture).root.children[0];
    expect(paragraph.children).toHaveLength(2);
    expect(paragraph.children[0]).toMatchObject({content:"before",x:0,y:0,textGrowth:"auto"});
    expect(paragraph.children[1]).toMatchObject({content:"after",x:68,y:20,textGrowth:"auto"});
  });

  test("uses clipping frames for transparent overflow wrappers", () => {
    const styles = { ...rootStyles, backgroundColor:"transparent", overflow:"hidden" };
    const capture = { format:"openpencil-capture-ir", version:1, rootPath:"0", label:"Clipped", source:{}, nodes:[
      { path:"0", parentPath:null, tag:"div", name:"root", text:null, rect:{x:0,y:0,width:200,height:100}, attributes:{}, styles:rootStyles },
      { path:"0.0", parentPath:"0", tag:"span", name:"badge", text:null, rect:{x:10,y:10,width:80,height:20}, attributes:{}, styles },
    ] };
    expect(convertCaptureToTree(capture).root.children[0]).toMatchObject({type:"frame",clip:true,x:10,y:10,width:80,height:20});
  });

  test("creates editable image fills for img and CSS background URLs", () => {
    const styles = { ...rootStyles, backgroundColor:"transparent", objectFit:"cover" };
    const capture = { format:"openpencil-capture-ir", version:1, rootPath:"0", label:"Assets", source:{}, nodes:[
      { path:"0", parentPath:null, tag:"div", name:"root", text:null, rect:{x:0,y:0,width:300,height:200}, attributes:{}, styles:rootStyles },
      { path:"0.0", parentPath:"0", tag:"img", name:"Portrait", text:null, rect:{x:10,y:10,width:80,height:80}, attributes:{alt:"Portrait",src:"data:image/png;base64,AA=="}, styles },
      { path:"0.1", parentPath:"0", tag:"div", name:"Hero", text:null, rect:{x:100,y:10,width:180,height:80}, attributes:{}, styles:{...styles,backgroundImage:'url("data:image/jpeg;base64,AA==")',backgroundSize:"cover"} },
    ] };
    const result = convertCaptureToTree(capture);
    expect(result.stats.images).toBe(2);
    expect(result.root.children[0]).toMatchObject({ type:"rectangle", name:"Image · Portrait", fill:{type:"image",mode:"fill",url:"data:image/png;base64,AA=="} });
    expect(result.root.children[1]).toMatchObject({ type:"frame", fill:{type:"image",mode:"fill",url:"data:image/jpeg;base64,AA=="} });
  });

  test("keeps the image source under editable filter overlays and embeds canvas pixels", () => {
    const styles = {...rootStyles,backgroundColor:"transparent",backgroundImage:"none",objectFit:"cover"};
    const capture = {format:"openpencil-capture-ir",version:1,rootPath:"0",label:"Portable",source:{url:"https://example.com/page"},nodes:[
      {path:"0",parentPath:null,tag:"div",name:"root",text:null,rect:{x:0,y:0,width:320,height:180},attributes:{},styles:rootStyles},
      {path:"0.0",parentPath:"0",tag:"img",name:"photo",text:null,rect:{x:10,y:10,width:120,height:80},attributes:{currentSrc:"https://example.com/photo.png",effectiveFilter:"brightness(0.6) grayscale(1)"},styles},
      {path:"0.1",parentPath:"0",tag:"canvas",name:"waveform",text:null,rect:{x:10,y:100,width:280,height:60},attributes:{dataUrl:"data:image/png;base64,BBBB"},styles},
    ]};
    const root = convertCaptureToTree(capture).root;
    expect(root.children[0]).toMatchObject({type:"frame",clip:true,metadata:{type:"openpencil-capture-image-filter",filter:"brightness(0.6) grayscale(1)"}});
    expect(root.children[0].children[0]).toMatchObject({type:"rectangle",fill:{type:"image",url:"https://example.com/photo.png"}});
    expect(root.children[0].children[1]).toMatchObject({fill:{type:"color",blendMode:"saturation"}});
    expect(root.children[0].children[2]).toMatchObject({fill:"#00000066"});
    expect(root.children[1]).toMatchObject({type:"rectangle",name:"Canvas · Snapshot",fill:{type:"image",url:"data:image/png;base64,BBBB",mode:"stretch"}});
  });

  test("names a tainted canvas instead of dropping its place in the layout", () => {
    const styles = {...rootStyles,backgroundColor:"transparent",backgroundImage:"none"};
    const capture = {format:"openpencil-capture-ir",version:1,rootPath:"0",label:"Tainted",source:{},nodes:[
      {path:"0",parentPath:null,tag:"div",name:"root",text:null,rect:{x:0,y:0,width:320,height:180},attributes:{},styles:rootStyles},
      {path:"0.0",parentPath:"0",tag:"canvas",name:"waveform",text:null,rect:{x:10,y:100,width:280,height:60},attributes:{dataUrl:null},styles},
    ]};
    expect(convertCaptureToTree(capture).root.children[0]).toMatchObject({type:"frame",name:"Canvas · Snapshot unavailable",x:10,y:100,width:280,height:60});
  });

  test("falls back from generic CSS font families to one the editor can load", () => {
    const text = {...rootStyles,backgroundColor:"transparent",color:"rgb(0, 0, 0)",fontSize:"14px",fontWeight:"400",fontStyle:"normal",lineHeight:"20px",textAlign:"start",textTransform:"none"};
    const family = (fontFamily) => convertCaptureToTree({format:"openpencil-capture-ir",version:1,rootPath:"0",label:"Text",source:{},nodes:[
      {path:"0",parentPath:null,tag:"div",name:"root",text:null,rect:{x:0,y:0,width:100,height:40},attributes:{},styles:rootStyles},
      {path:"0.0",parentPath:"0",tag:"p",name:"copy",text:"Copy",rect:{x:0,y:0,width:40,height:20},attributes:{},styles:{...text,fontFamily}},
    ]}).root.children[0].children[0].fontFamily;
    expect(family("ui-sans-serif, system-ui")).toBe("Inter");
    expect(family("-apple-system, Roboto")).toBe("Inter");
    expect(family('"Noto Sans", sans-serif')).toBe("Noto Sans");
  });

  test("preserves a CSS color blend overlay as an editable fill", () => {
    const capture = {format:"openpencil-capture-ir",version:1,rootPath:"0",label:"Filtered hero",source:{},nodes:[
      {path:"0",parentPath:null,tag:"div",name:"root",text:null,rect:{x:0,y:0,width:320,height:180},attributes:{},styles:rootStyles},
      {path:"0.0",parentPath:"0",tag:"div",name:"color overlay",text:null,rect:{x:0,y:0,width:320,height:180},attributes:{},styles:{...rootStyles,backgroundColor:"oklch(0.555 0.163 48.998)",mixBlendMode:"color",opacity:"0.5"}},
    ]};
    expect(convertCaptureToTree(capture).root.children[0]).toMatchObject({
      type:"frame",opacity:0.5,fill:{type:"color",color:"#BB4D00",blendMode:"color"},
    });
  });

  test("preserves LAB text colors and an empty colored badge bullet", () => {
    const textStyles = {...rootStyles,backgroundColor:"transparent",color:"lab(66.9756 -58.27 19.5419)",fontFamily:"Noto Sans",fontSize:"14px",fontWeight:"600",fontStyle:"normal",lineHeight:"20px",textAlign:"start",textTransform:"none"};
    const capture = {format:"openpencil-capture-ir",version:1,rootPath:"0",label:"Status",source:{},nodes:[
      {path:"0",parentPath:null,tag:"span",name:"badge",text:null,rect:{x:0,y:0,width:120,height:36},attributes:{},styles:{...rootStyles,backgroundColor:"transparent"}},
      {path:"0.0",parentPath:"0",tag:"span",name:"amount",text:"+$4,200.00",textRect:{x:16,y:8,width:72,height:20},textRuns:[{text:"+$4,200.00",rect:{x:16,y:8,width:72,height:20}}],rect:{x:16,y:8,width:72,height:20},attributes:{},styles:textStyles},
      {path:"0.1",parentPath:"0",tag:"span",name:"bullet",text:null,rect:{x:4,y:14,width:8,height:8},attributes:{},styles:{...rootStyles,backgroundColor:"lab(76.3898 14.5258 98.4589)",borderTopLeftRadius:"33554400px",borderTopRightRadius:"33554400px",borderBottomRightRadius:"33554400px",borderBottomLeftRadius:"33554400px"}},
    ]};
    const root = convertCaptureToTree(capture).root;
    expect(root.children[0].children[0]).toMatchObject({type:"text",content:"+$4,200.00",fill:"#00BC7D"});
    expect(root.children[1]).toMatchObject({type:"frame",fill:"#F0B100",width:8,height:8});
  });

  test("ignores a clear-text value recorded for a password field", () => {
    const capture = {format:"openpencil-capture-ir",version:1,rootPath:"0",label:"Login",source:{},nodes:[
      {path:"0",parentPath:null,tag:"input",name:"root",text:null,rect:{x:0,y:0,width:200,height:36},attributes:{type:"password",value:"old-secret"},styles:{...rootStyles,color:"rgb(0, 0, 0)",fontSize:"14px",lineHeight:"20px"}},
    ]};
    expect(JSON.stringify(convertCaptureToTree(capture))).not.toContain("old-secret");
    capture.nodes[0].attributes.type = "PASSWORD";
    expect(JSON.stringify(convertCaptureToTree(capture))).not.toContain("old-secret");
  });

  // Regression: a hidden root crashed with "Cannot set properties of null".
  test("explains that a hidden selection cannot be captured", () => {
    const capture = {format:"openpencil-capture-ir",version:1,rootPath:"0",label:"Hidden",source:{},nodes:[
      {path:"0",parentPath:null,tag:"div",name:"root",text:null,rect:{x:0,y:0,width:0,height:0},attributes:{},styles:rootStyles},
    ]};
    expect(() => convertCaptureToTree(capture)).toThrow("The selected element is not visible");
  });

  // Regression: a pattern matching any trailing ", 0)" read opaque rgb(0, 0, 0) as transparent.
  test("keeps opaque black gradient stops and recognizes transparent ones", () => {
    const fill = cssBackgroundToFill({rect:{width:10,height:10},attributes:{},styles:{backgroundImage:"linear-gradient(90deg, rgb(0, 0, 0), rgba(0, 0, 0, 0))"}});
    expect(fill.colors.map((stop) => stop.color)).toEqual(["#000000","#00000000"]);
    const modern = cssBackgroundToFill({rect:{width:10,height:10},attributes:{},styles:{backgroundImage:"linear-gradient(90deg, rgb(10 20 30 / 0), rgb(10 20 30 / 0.5))"}});
    expect(modern.colors.map((stop) => stop.color)).toEqual(["#0A141E00","#0A141E80"]);
  });

  // Regression: Tailwind's `to-blue-500/0` computes to `oklab(0 0 0 / 0)`, which dropped the stop and
  // with it the whole gradient.
  test("keeps a transparent stop written in a modern color space", () => {
    const fill = cssBackgroundToFill({rect:{width:10,height:10},attributes:{},styles:{backgroundImage:"linear-gradient(to right, oklch(0.623 0.214 259.815) 0%, oklab(0 0 0 / 0) 100%)"}});
    expect(fill.gradientType).toBe("linear");
    expect(fill.colors.at(-1).color).toMatch(/00$/);
  });

  // Regression: the default origin (padding box) inside a border made every bordered gradient a tile.
  test("keeps a bordered gradient a native gradient", () => {
    const sides = Object.fromEntries(["Top", "Right", "Bottom", "Left"].flatMap((side) => [[`border${side}Width`, "1px"], [`border${side}Style`, "solid"], [`border${side}Color`, "rgb(200, 200, 200)"]]));
    const {root} = convertCaptureToTree(ir(["0", "div", [0, 0, 300, 100], {...sides, backgroundColor:"rgba(0, 0, 0, 0)", backgroundImage:"linear-gradient(90deg, rgb(255, 0, 0), rgb(0, 0, 255))", backgroundRepeat:"repeat", backgroundOrigin:"padding-box", backgroundClip:"border-box", backgroundSize:"auto", backgroundPositionX:"0%", backgroundPositionY:"0%"}]));
    expect(root.fill).toMatchObject({type:"gradient", gradientType:"linear"});
  });

  test("keeps a gradient native when its area covers what it paints", () => {
    const sides = Object.fromEntries(["Top", "Right", "Bottom", "Left"].flatMap((side) => [[`border${side}Width`, "4px"], [`border${side}Style`, "solid"], [`border${side}Color`, "rgba(0, 0, 0, 0.5)"]]));
    const {root} = convertCaptureToTree(ir(["0", "div", [0, 0, 200, 100], {...sides, backgroundColor:"rgba(0, 0, 0, 0)", backgroundImage:"linear-gradient(rgb(255, 0, 0), rgb(0, 0, 255))", backgroundRepeat:"repeat", backgroundOrigin:"border-box", backgroundClip:"padding-box", backgroundSize:"auto", backgroundPositionX:"0%", backgroundPositionY:"0%"}]));
    expect([root.fill, ...root.children.map((child) => child.fill)].find((fill) => fill?.type)).toMatchObject({type:"gradient"});
  });

  test("places a userSpaceOnUse radial gradient against the shape's own box", () => {
    const svgNs = {namespace:"http://www.w3.org/2000/svg"};
    const tree = convertCaptureToTree(ir(
      ["0", "div", [0, 0, 48, 48]],
      ["0.0", "svg", [0, 0, 48, 48], {}, {...svgNs, attributes:{viewBox:"0 0 24 24"}}],
      ["0.0.0", "radialgradient", [0, 0, 0, 0], {}, {...svgNs, attributes:{id:"glow", gradientUnits:"userSpaceOnUse", cx:"12", cy:"6", r:"6"}}],
      ["0.0.0.0", "stop", [0, 0, 0, 0], {stopColor:"rgb(255, 255, 255)"}, {...svgNs, attributes:{offset:"0"}}],
      ["0.0.0.1", "stop", [0, 0, 0, 0], {stopColor:"rgb(0, 0, 0)"}, {...svgNs, attributes:{offset:"1"}}],
      ["0.0.1", "rect", [0, 0, 48, 24], {fill:"url(\"#glow\")", opacity:"1"}, {...svgNs, attributes:{width:"24", height:"12"}}],
    ));
    const rect = tree.root.children[0].children.find((child) => child.type === "rectangle");
    expect(rect.fill).toMatchObject({gradientType:"radial", center:{x:0.5, y:0.5}, radius:{x:0.25, y:0.5}});
  });

  // Mutation captured: measuring from the box center puts every stripe out of phase with the browser.
  test("starts repeating stripes at the CSS gradient line's start", () => {
    const capture = {format:"openpencil-capture-ir",version:1,rootPath:"0",label:"Stripes",source:{},nodes:[
      {path:"0",parentPath:null,tag:"div",name:"root",text:null,rect:{x:0,y:0,width:100,height:40},attributes:{},styles:{...rootStyles,backgroundImage:"repeating-linear-gradient(90deg, rgb(0, 0, 0) 0px, rgb(0, 0, 0) 2px, rgba(0, 0, 0, 0) 2px, rgba(0, 0, 0, 0) 10px)"}},
    ]};
    const stripes = convertCaptureToTree(capture).root.children[0].children;
    const stripeX = (stripe) => Number(stripe.geometry.match(/^M (-?[\d.]+)/)[1]);
    expect(stripes[0].strokeWidth).toBe(2);
    expect(stripeX(stripes[0])).toBeCloseTo(1);
    expect(stripeX(stripes[1])).toBeCloseTo(11);
  });

  test("materializes a transparent repeating gradient as uniform editable stripes", () => {
    const capture = {format:"openpencil-capture-ir",version:1,rootPath:"0",label:"Live",source:{},nodes:[
      {path:"0",parentPath:null,tag:"div",name:"media",text:null,rect:{x:0,y:0,width:320,height:180},attributes:{},styles:{...rootStyles,backgroundColor:"oklch(0.966 0.005 106.5)",backgroundImage:"repeating-linear-gradient(45deg, rgba(0, 0, 0, 0) 0px, rgba(0, 0, 0, 0) 10px, oklch(0.93 0.007 106.5) 10px, oklch(0.93 0.007 106.5) 11px)",overflow:"hidden"}},
    ]};
    const root = convertCaptureToTree(capture).root;
    expect(root.fill).toBe("#F4F4F0");
    expect(root.children[0]).toMatchObject({type:"frame",name:"Div · media · Background image",clip:true});
    expect(root.children[0].children.length).toBeGreaterThan(20);
    expect(root.children[0].children.every((child) => child.type === "path" && child.stroke === "#E8E8E3" && child.strokeWidth === 1)).toBe(true);
  });

  test("expands repeating linear gradients into OpenPencil gradient stops", () => {
    const node = { rect:{width:100,height:100}, attributes:{}, styles:{backgroundImage:"repeating-linear-gradient(45deg, rgba(0, 0, 0, 0) 0px, rgba(0, 0, 0, 0) 10px, rgb(220, 220, 215) 10px, rgb(220, 220, 215) 11px)"} };
    const fill = cssBackgroundToFill(node);
    expect(fill).toMatchObject({ type:"gradient", gradientType:"linear", rotation:315 });
    expect(fill.colors.length).toBeGreaterThan(20);
    expect(fill.colors.some((stop) => stop.color === "#00000000")).toBe(true);
  });

  test("resolves SVG linear-gradient paint servers with combined fill opacity", () => {
    const styles = {...rootStyles,backgroundColor:"transparent",fill:"none",fillOpacity:"1",stroke:"none",strokeWidth:"0"};
    const capture = {format:"openpencil-capture-ir",version:1,rootPath:"0",label:"Stock",source:{},nodes:[
      {path:"0",parentPath:null,tag:"div",name:"root",text:null,rect:{x:0,y:0,width:343,height:200},attributes:{},styles:rootStyles},
      {path:"0.0",parentPath:"0",tag:"svg",namespace:"http://www.w3.org/2000/svg",name:"chart",text:null,rect:{x:0,y:0,width:343,height:200},attributes:{viewBox:"0 0 343 200"},styles},
      {path:"0.0.0",parentPath:"0.0",tag:"defs",namespace:"http://www.w3.org/2000/svg",name:"defs",text:null,rect:{x:0,y:0,width:0,height:0},attributes:{},styles},
      {path:"0.0.0.0",parentPath:"0.0.0",tag:"lineargradient",namespace:"http://www.w3.org/2000/svg",name:"gradient",text:null,rect:{x:0,y:0,width:0,height:0},attributes:{id:"fillPrice",x1:"0",y1:"0",x2:"0",y2:"1"},styles},
      {path:"0.0.0.0.0",parentPath:"0.0.0.0",tag:"stop",namespace:"http://www.w3.org/2000/svg",name:"stop",text:null,rect:{x:0,y:0,width:0,height:0},attributes:{offset:"0%","stop-color":"oklch(0.879 0.169 91.605)","stop-opacity":"0.3"},styles:{...styles,stopColor:"oklch(0.879 0.169 91.605)",stopOpacity:"0.3"}},
      {path:"0.0.0.0.1",parentPath:"0.0.0.0",tag:"stop",namespace:"http://www.w3.org/2000/svg",name:"stop",text:null,rect:{x:0,y:0,width:0,height:0},attributes:{offset:"100%","stop-color":"oklch(0.879 0.169 91.605)","stop-opacity":"0.05"},styles:{...styles,stopColor:"oklch(0.879 0.169 91.605)",stopOpacity:"0.05"}},
      {path:"0.0.1",parentPath:"0.0",tag:"path",namespace:"http://www.w3.org/2000/svg",name:"area",text:null,rect:{x:0,y:52,width:343,height:148},attributes:{d:"M0 68L343 52L343 200L0 200Z"},styles:{...styles,fill:'url("#fillPrice")',fillOpacity:"0.6"}},
    ]};
    const area = convertCaptureToTree(capture).root.children[0].children.find((child) => child.type === "path");
    expect(area.fill).toMatchObject({type:"gradient",gradientType:"linear",rotation:180});
    expect(area.fill.colors).toEqual([{color:"#FFD2302E",position:0},{color:"#FFD23008",position:1}]);
  });
});
