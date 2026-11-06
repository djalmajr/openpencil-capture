import { describe, expect, test } from "bun:test";
import { applyGradientTransform, invertGradientTransform } from "@open-pencil/scene-graph/gradient";
import { collectImageRequests, hexToColor, toSceneNodes } from "../src/scene-nodes.mjs";

const frame = (children, extra = {}) => ({type:"frame", name:"Root", x:0, y:0, width:100, height:100, children, ...extra});
const convertChild = (child, hashes) => toSceneNodes(frame([child]), hashes).children[0];
const gradientEnds = (paint, width, height) => {
  const toLayer = invertGradientTransform(paint.gradientTransform);
  const point = (x) => {
    const unit = applyGradientTransform(toLayer, {x, y:0.5});
    return {x:Math.round(unit.x * width) + 0, y:Math.round(unit.y * height) + 0};
  };
  return [point(0), point(1)];
};

describe("paint", () => {
  test("expands short and long hex colors", () => {
    expect(hexToColor("#FF8000")).toEqual({r:1, g:128 / 255, b:0, a:1});
    expect(hexToColor("#00000080")).toEqual({r:0, g:0, b:0, a:128 / 255});
    expect(hexToColor("#F00")).toEqual({r:1, g:0, b:0, a:1});
  });

  // Mutation captured: leaving alpha in color.a too would square it on text, which multiplies both.
  test("carries a solid paint's alpha only in opacity", () => {
    const [paint] = convertChild({type:"rectangle", name:"R", x:0, y:0, width:1, height:1, fill:"#FF000080"}).fills;
    expect(paint.color).toEqual({r:1, g:0, b:0, a:1});
    expect(paint.opacity).toBeCloseTo(128 / 255);
  });

  test("drops a fully transparent fill instead of painting it", () => {
    expect(convertChild({type:"rectangle", name:"R", x:0, y:0, width:1, height:1, fill:"#00000000"}).fills).toEqual([]);
  });

  test("maps a CSS blend overlay to the editor's blend mode", () => {
    const [paint] = convertChild({type:"rectangle", name:"R", x:0, y:0, width:1, height:1, fill:{type:"color", color:"#808080FF", blendMode:"saturation"}}).fills;
    expect(paint).toMatchObject({type:"SOLID", blendMode:"SATURATION"});
    const [lighten] = convertChild({type:"rectangle", name:"R", x:0, y:0, width:1, height:1, fill:{type:"color", color:"#808080FF", blendMode:"light"}}).fills;
    expect(lighten.blendMode).toBe("LIGHTEN");
  });

  test.each([
    [180, [{x:50, y:0}, {x:50, y:40}]],
    [90, [{x:0, y:20}, {x:100, y:20}]],
    [0, [{x:50, y:40}, {x:50, y:0}]],
    [270, [{x:100, y:20}, {x:0, y:20}]],
  ])("runs a linear gradient along CSS angle %ddeg in layer pixels", (cssAngle, ends) => {
    const [paint] = convertChild({type:"rectangle", name:"R", x:0, y:0, width:100, height:40, fill:{
      type:"gradient", gradientType:"linear", rotation:(360 - cssAngle) % 360,
      colors:[{color:"#FF0000", position:0}, {color:"#0000FF80", position:1}],
    }}).fills;
    expect(paint.type).toBe("GRADIENT_LINEAR");
    expect(gradientEnds(paint, 100, 40)).toEqual(ends);
    expect(paint.gradientStops[1].color.a).toBeCloseTo(128 / 255);
  });

  test("uses the CSS corner-to-corner length for a diagonal gradient", () => {
    const [paint] = convertChild({type:"rectangle", name:"R", x:0, y:0, width:100, height:100, fill:{
      type:"gradient", gradientType:"linear", rotation:225,
      colors:[{color:"#FF0000", position:0}, {color:"#0000FF", position:1}],
    }}).fills;
    expect(gradientEnds(paint, 100, 100)).toEqual([{x:0, y:0}, {x:100, y:100}]);
  });

  // Mutation captured: keeping the stop's own RGB makes a white-to-transparent overlay turn grey midway.
  test("fades a transparent gradient stop toward its neighbor's hue", () => {
    const [paint] = convertChild({type:"rectangle", name:"R", x:0, y:0, width:10, height:10, fill:{
      type:"gradient", gradientType:"linear", rotation:90,
      colors:[{color:"#FFFFFFB3", position:0}, {color:"#00000000", position:1}],
    }}).fills;
    expect(paint.gradientStops[1].color).toEqual({r:1, g:1, b:1, a:0});
    expect(paint.gradientStops[1].position).toBe(1);
  });

  test.each([["fit", "FIT"], ["fill", "FILL"], ["stretch", "CROP"]])("maps image mode %s to %s", (mode, scaleMode) => {
    const url = "https://example.test/a.png";
    const [paint] = convertChild({type:"rectangle", name:"R", x:0, y:0, width:1, height:1, fill:{type:"image", url, mode}}, new Map([[url, "hash"]])).fills;
    expect(paint).toMatchObject({type:"IMAGE", imageHash:"hash", imageScaleMode:scaleMode});
    expect(Boolean(paint.imageTransform)).toBe(mode === "stretch");
  });

  test("leaves the layer unpainted and labelled when its image is missing", () => {
    const node = convertChild({type:"rectangle", name:"Photo", x:0, y:0, width:1, height:1, fill:{type:"image", url:"https://example.test/a.png", mode:"fill"}});
    expect(node.fills).toEqual([]);
    expect(node.name).toBe("Photo · Image unavailable");
  });
});

describe("borders and corners", () => {
  test("maps a uniform CSS border to an inside stroke", () => {
    const node = toSceneNodes(frame([], {stroke:"#112233", strokeWidth:2, strokeAlignment:"inner"}));
    expect(node.strokes[0]).toMatchObject({type:"SOLID", weight:2, align:"INSIDE", visible:true});
    expect(node).toMatchObject({strokeWeight:2, strokeAlign:"INSIDE"});
    expect(node.independentStrokeWeights).toBeUndefined();
  });

  test("keeps per-side border widths", () => {
    const node = toSceneNodes(frame([], {stroke:"#112233", strokeWidth:{top:0, right:0, bottom:1, left:3}, strokeAlignment:"inner"}));
    expect(node).toMatchObject({independentStrokeWeights:true, borderTopWeight:0, borderRightWeight:0, borderBottomWeight:1, borderLeftWeight:3, strokeWeight:3});
  });

  test("keeps uniform and per-corner radii", () => {
    expect(toSceneNodes(frame([], {cornerRadius:8})).cornerRadius).toBe(8);
    expect(toSceneNodes(frame([], {cornerRadius:[1, 2, 3, 4]}))).toMatchObject({independentCorners:true, topLeftRadius:1, topRightRadius:2, bottomRightRadius:3, bottomLeftRadius:4});
  });

  test("maps box shadows to effects", () => {
    const {effects} = toSceneNodes(frame([], {effect:[
      {type:"shadow", shadowType:"outer", offset:{x:0, y:2}, blur:4, spread:1, color:"#00000040"},
      {type:"shadow", shadowType:"inner", offset:{x:1, y:0}, blur:0, spread:0, color:"#FF0000"},
    ]}));
    expect(effects[0]).toMatchObject({type:"DROP_SHADOW", visible:true, offset:{x:0, y:2}, radius:4, spread:1});
    expect(effects[0].color.a).toBeCloseTo(64 / 255);
    expect(effects[1].type).toBe("INNER_SHADOW");
  });
});

describe("text", () => {
  const text = {type:"text", name:"T", x:10, y:20, content:"Hello", fill:"#000000", fontFamily:"Inter", fontSize:14, fontWeight:"600", fontStyle:"italic", lineHeight:1.429, textAlign:"center", textAlignVertical:"middle", textGrowth:"auto", measured:{width:40, height:17, lineHeight:20}};

  test("maps typography to the editor's fields", () => {
    expect(convertChild(text)).toMatchObject({type:"TEXT", text:"Hello", fontFamily:"Inter", fontSize:14, fontWeight:600, italic:true, lineHeight:20, textAlignHorizontal:"CENTER", textAlignVertical:"CENTER", textAutoResize:"WIDTH_AND_HEIGHT", width:40});
  });

  // Mutation captured: without the half-leading offset each text layer sits 1.5px low here.
  test("centers the inline box inside the taller line box, as CSS does", () => {
    expect(convertChild(text)).toMatchObject({y:18.5, height:20});
    expect(convertChild({...text, measured:{width:40, height:17, lineHeight:14}})).toMatchObject({y:21.5, height:14});
  });

  test("keeps the measured box when the text spans several lines", () => {
    expect(convertChild({...text, textGrowth:"fixed-width-height", measured:{width:40, height:60, lineHeight:20}})).toMatchObject({y:20, height:60, textAutoResize:"NONE"});
  });

  test("keeps letter spacing only when present", () => {
    expect(convertChild({...text, letterSpacing:-0.5}).letterSpacing).toBe(-0.5);
    expect(convertChild(text).letterSpacing).toBeUndefined();
  });
});

describe("vectors", () => {
  const path = {type:"path", name:"P", x:0, y:0, width:48, height:48, viewBox:[0, 0, 24, 24], fill:"#FF0000"};

  test("scales path geometry from the viewBox into the layer's pixels and fits its box", () => {
    const node = convertChild({...path, geometry:"M4 4 H12 V8 H4 Z"});
    expect(node).toMatchObject({type:"VECTOR", x:8, y:8, width:16, height:8});
    expect(node.vectorNetwork.vertices).toContainEqual({x:0, y:0});
    expect(node.vectorNetwork.vertices).toContainEqual({x:16, y:8});
    expect(node.vectorNetwork.regions[0].windingRule).toBe("NONZERO");
  });

  test("letterboxes a mismatched viewBox instead of distorting it", () => {
    const node = convertChild({...path, width:100, height:48, geometry:"M0 0 H24 V24 H0 Z"});
    expect(node).toMatchObject({x:26, y:0, width:48, height:48});
  });

  test("stretches the viewBox when preserveAspectRatio is none", () => {
    const node = convertChild({...path, width:100, height:48, stretchViewBox:true, geometry:"M0 0 H24 V24 H0 Z"});
    expect(node).toMatchObject({x:0, y:0, width:100, height:48});
  });

  test("honors a viewBox that does not start at the origin", () => {
    const node = convertChild({...path, viewBox:[10, 10, 24, 24], geometry:"M10 10 H34 V34 H10 Z"});
    expect(node).toMatchObject({x:0, y:0, width:48, height:48});
  });

  test("measures curves by their real extent, not their control points", () => {
    const node = convertChild({...path, viewBox:[0, 0, 48, 48], geometry:"M0 0 C0 40 48 40 48 0"});
    expect(node.height).toBe(30);
    expect(node.width).toBe(48);
  });

  test("keeps the even-odd fill rule", () => {
    expect(convertChild({...path, fillRule:"evenodd", geometry:"M0 0 H24 V24 H0 Z"}).vectorNetwork.regions[0].windingRule).toBe("EVENODD");
  });

  test("fills open subpaths when painted, as SVG does, but not when only stroked", () => {
    expect(convertChild({...path, geometry:"M0 0 H24 V24"}).vectorNetwork.regions).toHaveLength(1);
    expect(convertChild({...path, fill:"#00000000", stroke:"#000000", strokeWidth:2, geometry:"M0 0 H24 V24"}).vectorNetwork.regions).toHaveLength(0);
  });

  test("centers SVG strokes and maps caps and joins", () => {
    const node = convertChild({...path, stroke:"#000000", strokeWidth:2, strokeLinecap:"round", strokeLinejoin:"round", geometry:"M0 0 H24"});
    expect(node).toMatchObject({strokeAlign:"CENTER", strokeCap:"ROUND", strokeJoin:"ROUND"});
    expect(node.strokes[0]).toMatchObject({weight:2, align:"CENTER", cap:"ROUND", join:"ROUND"});
  });

  test("drops a path it cannot parse", () => {
    expect(toSceneNodes(frame([{...path, geometry:"not a path"}])).children).toEqual([]);
  });
});

describe("structure", () => {
  test("gives every node a unique id", () => {
    const ids = [];
    const visit = (node) => { ids.push(node.id); node.children?.forEach(visit); };
    visit(toSceneNodes(frame([frame([]), frame([frame([])])])));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(4);
  });

  test("fits nested groups around their children", () => {
    const node = convertChild({type:"group", name:"Outer", x:10, y:10, children:[
      {type:"group", name:"Inner", x:5, y:5, children:[
        {type:"rectangle", name:"A", x:0, y:0, width:10, height:10, fill:"#000000"},
        {type:"rectangle", name:"B", x:20, y:30, width:10, height:10, fill:"#000000"},
      ]},
    ]});
    expect(node).toMatchObject({type:"GROUP", x:15, y:15, width:30, height:40});
    expect(node.children[0]).toMatchObject({type:"GROUP", x:0, y:0, width:30, height:40});
    expect(node.children[0].children[1]).toMatchObject({x:20, y:30});
  });

  test("drops a group with nothing left inside", () => {
    expect(toSceneNodes(frame([{type:"group", name:"Empty", x:0, y:0, children:[]}])).children).toEqual([]);
  });

  test("keeps clipping and layer opacity", () => {
    expect(toSceneNodes(frame([], {clip:true, opacity:0.5}))).toMatchObject({clipsContent:true, opacity:0.5, layoutMode:"NONE"});
    expect(toSceneNodes(frame([])).clipsContent).toBe(false);
  });

  test("asks for each image once, at the largest size it is shown", () => {
    const fill = {type:"image", url:"https://example.test/a.png", mode:"fill"};
    const requests = collectImageRequests(frame([
      {type:"rectangle", name:"A", x:0, y:0, width:10, height:90, fill},
      {type:"rectangle", name:"B", x:0, y:0, width:30, height:20, fill},
    ]));
    expect([...requests]).toEqual([["https://example.test/a.png", {width:30, height:90}]]);
  });
});
