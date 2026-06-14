import { CDP_PROTOCOL_VERSION } from "@webbridge/shared";

const BROWSER_INTERNAL_PROTOCOLS = new Set([
  "chrome:",
  "chrome-extension:",
  "devtools:",
  "edge:",
  "moz-extension:",
  "opera:",
  "vivaldi:",
]);

function isBrowserInternalUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return BROWSER_INTERNAL_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return /^(chrome|chrome-extension|devtools|edge|moz-extension|opera|vivaldi):/i.test(url);
  }
}

export class CDPBridge {
  private attached = new Set<number>();

  constructor() {
    chrome.debugger.onDetach.addListener((source, reason) => {
      if (source.tabId !== undefined) {
        this.attached.delete(source.tabId);
        console.log(`[CDP] Detached from tab ${source.tabId}: ${reason}`);
      }
    });
  }

  async attach(tabId: number): Promise<void> {
    if (this.attached.has(tabId)) return;

    try {
      await chrome.debugger.attach({ tabId }, CDP_PROTOCOL_VERSION);
      this.attached.add(tabId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      if (msg.includes("Another debugger")) {
        // Try to query actual targets to see if *we* already own it
        const targets = await chrome.debugger.getTargets();
        const target = targets.find((t) => t.tabId === tabId);
        if (target?.attached) {
          // Already attached by us (state was out of sync), fix it
          this.attached.add(tabId);
          return;
        }
        throw new Error(
          `Tab ${tabId} has another debugger attached (DevTools or another extension). ` +
          `Close DevTools on that tab and retry.`
        );
      }

      const tab = await chrome.tabs.get(tabId).catch(() => undefined);
      if (isBrowserInternalUrl(tab?.url)) {
        throw new Error(
          `Cannot attach CDP debugger to tab ${tabId} because it has a browser-internal URL (${tab?.url}). ` +
          `Chrome does not allow debugger access to this page; select or navigate to a normal web page and retry.`
        );
      }

      throw new Error(`Failed to attach debugger to tab ${tabId}: ${msg}`);
    }
  }

  async detach(tabId: number): Promise<void> {
    if (!this.attached.has(tabId)) return;

    try {
      await chrome.debugger.detach({ tabId });
    } catch {
      // already detached
    }
    this.attached.delete(tabId);
  }

  async send<T = unknown>(
    tabId: number,
    method: string,
    params?: Record<string, unknown>
  ): Promise<T> {
    await this.attach(tabId);
    try {
      const result = await chrome.debugger.sendCommand({ tabId }, method, params);
      return result as T;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      // If attachment was lost mid-call, try one re-attach + retry
      if (msg.includes("not attached") || msg.includes("Debugger is not attached")) {
        this.attached.delete(tabId);
        await this.attach(tabId);
        const result = await chrome.debugger.sendCommand({ tabId }, method, params);
        return result as T;
      }
      throw err;
    }
  }

  async detachAll(): Promise<void> {
    const tabIds = [...this.attached];
    await Promise.allSettled(tabIds.map((id) => this.detach(id)));
  }

  isAttached(tabId: number): boolean {
    return this.attached.has(tabId);
  }
}

export const cdpBridge = new CDPBridge();
