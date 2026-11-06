export async function waitForVisualStability(snapshot, options = {}) {
  const intervalMs = options.intervalMs ?? 80;
  const stableSamples = options.stableSamples ?? 3;
  const timeoutMs = options.timeoutMs ?? 2500;
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve,ms)));
  const startedAt = Date.now();
  let previous = null;
  let stable = 0;
  while (Date.now()-startedAt < timeoutMs) {
    const current = snapshot();
    stable = current === previous ? stable+1 : 0;
    if (stable >= stableSamples) return {stable:true,signature:current};
    previous = current;
    await sleep(intervalMs);
  }
  return {stable:false,signature:previous};
}

export function elementVisualSignature(target) {
  const nodes = [target,...target.querySelectorAll("svg path,svg rect,svg circle,svg ellipse,svg line,svg polyline,svg polygon")];
  return nodes.map((node) => {
    const rect = node.getBoundingClientRect();
    return [node.tagName,node.getAttribute("d"),node.getAttribute("points"),node.getAttribute("transform"),rect.x,rect.y,rect.width,rect.height].join(":");
  }).join("|");
}
