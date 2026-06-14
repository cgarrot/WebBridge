import { cdpBridge } from "./bridge.js";

const BROWSER_INTERNAL_PROTOCOLS = new Set([
  "chrome:",
  "chrome-extension:",
  "devtools:",
  "edge:",
  "moz-extension:",
  "opera:",
  "vivaldi:",
]);

export function isBrowserInternalUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return BROWSER_INTERNAL_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return /^(chrome|chrome-extension|devtools|edge|moz-extension|opera|vivaldi):/i.test(url);
  }
}

export async function getActiveTabId(): Promise<number> {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  if (tab?.id == null) throw new Error("No active tab found");
  return tab.id;
}

async function tabExists(tabId: number): Promise<boolean> {
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}

export async function resolveTabId(tabId?: number): Promise<number> {
  if (tabId == null) return getActiveTabId();
  if (await tabExists(tabId)) return tabId;

  try {
    return await getActiveTabId();
  } catch {
    throw new Error(
      `Tab ${tabId} is stale or closed, and no active tab is available. Open or select a tab, then retry without tabId or with a current tabId.`
    );
  }
}

export async function ensureAttached(tabId: number): Promise<void> {
  await cdpBridge.attach(tabId);
}

export async function waitForPageLoad(
  tabId: number,
  timeoutMs = 30_000
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.debugger.onEvent.removeListener(listener);
      reject(new Error(`Page load timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    const listener = (
      source: chrome.debugger.Debuggee,
      method: string
    ) => {
      if (source.tabId === tabId && method === "Page.loadEventFired") {
        clearTimeout(timer);
        chrome.debugger.onEvent.removeListener(listener);
        resolve();
      }
    };

    chrome.debugger.onEvent.addListener(listener);
  });
}
