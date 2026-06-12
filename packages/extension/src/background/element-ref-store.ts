interface ElementRefEntry {
  backendNodeId: number;
  createdAt: number;
}

const TTL_MS = 2 * 60 * 1000;
const refsByTab = new Map<number, Map<string, ElementRefEntry>>();

export function replaceElementRefs(tabId: number, backendNodeIds: number[]): Map<number, string> {
  const refs = new Map<string, ElementRefEntry>();
  const labels = new Map<number, string>();

  backendNodeIds.forEach((backendNodeId, index) => {
    const ref = `@e${index + 1}`;
    refs.set(ref, { backendNodeId, createdAt: Date.now() });
    labels.set(backendNodeId, ref);
  });

  refsByTab.set(tabId, refs);
  return labels;
}

export function resolveElementRef(tabId: number, ref: string): number | undefined {
  const refs = refsByTab.get(tabId);
  const entry = refs?.get(ref);
  if (!entry) return undefined;
  if (Date.now() - entry.createdAt > TTL_MS) {
    refs?.delete(ref);
    return undefined;
  }
  return entry.backendNodeId;
}

export function clearElementRefs(tabId: number): void {
  refsByTab.delete(tabId);
}
