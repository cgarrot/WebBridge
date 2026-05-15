import { cdpBridge } from "./bridge.js";
import { CURSOR_ANIMATION_MS } from "@webbridge/shared";

const injected = new Set<number>();

export async function ensureCursorInjected(tabId: number): Promise<void> {
  if (injected.has(tabId)) {
    const check = await cdpBridge.send<{ result: { value: boolean } }>(
      tabId,
      "Runtime.evaluate",
      { expression: "!!window.__webbridge_cursor__", returnByValue: true }
    );
    if (check.result.value) return;
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content/cursor-overlay.js"],
  });
  injected.add(tabId);
}

export async function moveCursor(
  tabId: number,
  x: number,
  y: number,
  animate = true
): Promise<void> {
  await ensureCursorInjected(tabId);
  await cdpBridge.send(tabId, "Runtime.evaluate", {
    expression: `window.__webbridge_cursor__.moveTo(${x},${y},${animate})`,
    returnByValue: true,
  });
  if (animate) {
    await sleep(CURSOR_ANIMATION_MS);
  }
}

export async function cursorClickEffect(
  tabId: number,
  x: number,
  y: number
): Promise<void> {
  await ensureCursorInjected(tabId);
  await cdpBridge.send(tabId, "Runtime.evaluate", {
    expression: `window.__webbridge_cursor__.clickEffect(${x},${y})`,
    returnByValue: true,
  });
}

export async function hideCursor(tabId: number): Promise<void> {
  if (!injected.has(tabId)) return;
  await cdpBridge.send(tabId, "Runtime.evaluate", {
    expression: `window.__webbridge_cursor__?.hide()`,
    returnByValue: true,
  });
}

export async function highlightRect(
  tabId: number,
  rect: { x: number; y: number; width: number; height: number } | null
): Promise<void> {
  await ensureCursorInjected(tabId);
  const arg = rect ? JSON.stringify(rect) : "null";
  await cdpBridge.send(tabId, "Runtime.evaluate", {
    expression: `window.__webbridge_cursor__.highlightRect(${arg})`,
    returnByValue: true,
  });
}

export function clearInjectedState(tabId: number): void {
  injected.delete(tabId);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
