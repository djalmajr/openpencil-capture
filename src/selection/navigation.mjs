export function createSelectionState(initial = null) {
  return { current: initial, rememberedChildren: new Map() };
}

export function setHoveredTarget(state, target) {
  state.current = target;
  return state.current;
}

export function selectParent(state, boundary = null) {
  const parent = state.current?.parentElement;
  if (!parent || parent === boundary) return state.current;
  state.rememberedChildren.set(parent, state.current);
  state.current = parent;
  return state.current;
}

export function selectChild(state) {
  if (!state.current) return null;
  const remembered = state.rememberedChildren.get(state.current);
  const child = remembered?.parentElement === state.current ? remembered : state.current.firstElementChild;
  if (child) state.current = child;
  return state.current;
}
