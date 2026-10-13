import { cdpBridge } from "./bridge.js";
import {
  NAVIGATE_SETTLE_MS,
  NAVIGATE_LOAD_TIMEOUT_MS,
  NAVIGATE_NETWORKIDLE_TIMEOUT_MS,
} from "@webbridge/shared";

/**
 * Reliable, SPA-friendly page-load waiting.
 *
 * The old implementation waited up to 30s for Chrome's `tab.status === "complete"`,
 * which never resolves for many SPAs (persistent websockets, long-polling). That made
 * every navigation time out, which made callers retry, which created more tabs.
 *
 * This module honors `waitUntil` via CDP with short, bounded timeouts so a result
 * always returns well before the caller aborts and retries.
 */

export type WaitUntil = "load" | "domcontentloaded" | "networkidle";

export type LoadStrategy =
  | { kind: "none" }
  | { kind: "settle"; ms: number }
  | { kind: "load"; timeoutMs: number }
  | { kind: "networkidle"; timeoutMs: number };

export interface LoadWaitResult {
  loaded: boolean;
  strategy: LoadStrategy["kind"];
  elapsedMs: number;
  reason: string;
}

export function resolveLoadStrategy(waitUntil?: WaitUntil): LoadStrategy {
  switch (waitUntil) {
    case "domcontentloaded":
      return { kind: "none" };
    case "load":
      return { kind: "load", timeoutMs: NAVIGATE_LOAD_TIMEOUT_MS };
    case "networkidle":
      return { kind: "networkidle", timeoutMs: NAVIGATE_NETWORKIDLE_TIMEOUT_MS };
    default:
      return { kind: "settle", ms: NAVIGATE_SETTLE_MS };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function waitForLoad(tabId: number, strategy: LoadStrategy): Promise<LoadWaitResult> {
  const start = Date.now();

  switch (strategy.kind) {
    case "none":
      return { loaded: true, strategy: "none", elapsedMs: 0, reason: "domcontentloaded (no wait)" };

    case "settle":
      await sleep(strategy.ms);
      return {
        loaded: true,
        strategy: "settle",
        elapsedMs: Date.now() - start,
        reason: `settled ${strategy.ms}ms`,
      };

    case "load":
      return waitForLoadEvent(tabId, strategy.timeoutMs, start);

    case "networkidle":
      return waitForNetworkIdle(tabId, strategy.timeoutMs, start);
  }
}

/**
 * Wait for CDP `Page.loadEventFired`. Resolves early if the document is already
 * complete (common when navigating to an already-cached/simple page). Non-fatal
 * on timeout: returns loaded:false instead of throwing.
 */
function waitForLoadEvent(tabId: number, timeoutMs: number, start: number): Promise<LoadWaitResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (loaded: boolean, reason: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.debugger.onEvent.removeListener(listener);
      resolve({ loaded, strategy: "load", elapsedMs: Date.now() - start, reason });
    };

    const timer = setTimeout(() => finish(false, `load timeout after ${timeoutMs}ms`), timeoutMs);

    const listener = (source: chrome.debugger.Debuggee, method: string) => {
      if (source.tabId === tabId && method === "Page.loadEventFired") finish(true, "Page.loadEventFired");
    };

    (async () => {
      try {
        await cdpBridge.attach(tabId);
        await cdpBridge.send(tabId, "Page.enable").catch(() => undefined);
        chrome.debugger.onEvent.addListener(listener);

        // Fast path: document may already be complete.
        const state = await cdpBridge
          .send<{ result?: { value?: string } }>(tabId, "Runtime.evaluate", {
            expression: "document.readyState",
            returnByValue: true,
          })
          .catch(() => undefined);
        if (state?.result?.value === "complete") finish(true, "readyState complete");
      } catch {
        // Attach/enable failed (e.g. browser-internal URL). Best-effort: keep the
        // listener-less timeout so we still return within budget.
      }
    })();
  });
}

/**
 * Wait for network idle: no in-flight requests for 500ms. Non-fatal on timeout.
 */
function waitForNetworkIdle(tabId: number, timeoutMs: number, start: number): Promise<LoadWaitResult> {
  return new Promise((resolve) => {
    let settled = false;
    let pending = 0;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = (loaded: boolean, reason: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (idleTimer) clearTimeout(idleTimer);
      chrome.debugger.onEvent.removeListener(listener);
      resolve({ loaded, strategy: "networkidle", elapsedMs: Date.now() - start, reason });
    };

    const deadline = setTimeout(() => finish(false, `networkidle timeout after ${timeoutMs}ms`), timeoutMs);

    const checkIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (pending <= 0) {
        idleTimer = setTimeout(() => finish(true, "network idle 500ms"), 500);
      }
    };

    const listener = (source: chrome.debugger.Debuggee, method: string) => {
      if (source.tabId !== tabId) return;
      if (method === "Network.requestWillBeSent") {
        pending++;
        if (idleTimer) clearTimeout(idleTimer);
      } else if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
        pending = Math.max(0, pending - 1);
        checkIdle();
      }
    };

    (async () => {
      try {
        await cdpBridge.attach(tabId);
        await cdpBridge.send(tabId, "Network.enable").catch(() => undefined);
        chrome.debugger.onEvent.addListener(listener);
        checkIdle();
      } catch {
        finish(false, "network enable failed");
      }
    })();
  });
}
