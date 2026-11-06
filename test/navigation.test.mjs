import { describe, expect, test } from "bun:test";
import { createSelectionState, selectChild, selectParent } from "../src/selection/navigation.mjs";

function node(name, parent = null) {
  const value = { name, parentElement:parent, firstElementChild:null };
  if (parent && !parent.firstElementChild) parent.firstElementChild = value;
  return value;
}

describe("DOM tree keyboard navigation", () => {
  test("moves to the parent and returns to the remembered child", () => {
    const body = node("body");
    const card = node("card", body);
    const title = node("title", card);
    const state = createSelectionState(title);
    expect(selectParent(state)).toBe(card);
    expect(selectChild(state)).toBe(title);
  });
});
