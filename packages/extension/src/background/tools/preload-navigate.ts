import type { PreloadNavigateArgs } from "@webbridge/shared";
import { BaseTool, type ToolContext } from "./base.js";
import { resolveTabId } from "../../cdp/session.js";
import { sessionManager } from "../session-manager.js";

const MAX_PRELOAD_SOURCE_CHARS = 250_000;
const DEFAULT_INITIAL_URL = "about:blank";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sameUrlTarget(observed: string | undefined, expected: string): boolean {
  if (!observed) return false;
  try {
    const observedUrl = new URL(observed);
    const expectedUrl = new URL(expected);
    return observedUrl.hostname === expectedUrl.hostname
      && observedUrl.pathname.replace(/\/+$/g, "") === expectedUrl.pathname.replace(/\/+$/g, "");
  } catch {
    return observed === expected;
  }
}

async function waitForTabUrl(tabId: number, expectedUrl: string, timeoutMs: number): Promise<chrome.tabs.Tab> {
  const deadline = Date.now() + timeoutMs;
  let lastTab = await chrome.tabs.get(tabId);
  while (Date.now() < deadline) {
    lastTab = await chrome.tabs.get(tabId);
    if (sameUrlTarget(lastTab.url, expectedUrl)) return lastTab;
    await sleep(200);
  }
  return lastTab;
}

export class PreloadNavigateTool extends BaseTool {
  readonly name = "preload_navigate" as const;
  readonly description = "Create/select a tab, register a CDP document-start preload script, then navigate the same tab to a URL";

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
    const {
      url,
      source,
      tabId: rawTabId,
      newTab = true,
      initialUrl = DEFAULT_INITIAL_URL,
      active = true,
      group_title,
      groupTitle,
      initialWaitMs = 300,
      urlWaitMs = 500,
    } = args as unknown as PreloadNavigateArgs;

    if (!url || typeof url !== "string") throw new Error("preload_navigate: url is required");
    if (!source || typeof source !== "string") throw new Error("preload_navigate: source is required");
    if (source.length > MAX_PRELOAD_SOURCE_CHARS) {
      throw new Error(`preload_navigate: source is too large (${source.length} chars, max ${MAX_PRELOAD_SOURCE_CHARS})`);
    }

    const sessionTitle = groupTitle ?? group_title;
    if (sessionTitle) await sessionManager.nameSession(sessionTitle);

    let tabId: number;
    let created = false;
    if (newTab) {
      const tab = await chrome.tabs.create({ url: initialUrl || DEFAULT_INITIAL_URL, active });
      if (tab.id === undefined) throw new Error("preload_navigate: failed to create tab");
      tabId = tab.id;
      created = true;
    } else {
      tabId = await resolveTabId(rawTabId);
      if (active) await chrome.tabs.update(tabId, { active: true });
      if (initialUrl) await chrome.tabs.update(tabId, { url: initialUrl });
    }

    const boundedInitialWaitMs = Math.max(0, Math.min(10_000, Number(initialWaitMs) || 0));
    if (boundedInitialWaitMs > 0) await sleep(boundedInitialWaitMs);

    await ctx.cdp.send(tabId, "Page.enable");
    await ctx.cdp.send(tabId, "Runtime.enable").catch(() => undefined);
    const preload = await ctx.cdp.send<{ identifier?: string }>(
      tabId,
      "Page.addScriptToEvaluateOnNewDocument",
      { source },
    );

    // Use chrome.tabs.update for the actual navigation after the preload is
    // registered, so extension-level tab state and the browser UI stay aligned
    // with the requested URL.
    const navigation = await chrome.tabs.update(tabId, { url, active });

    const boundedUrlWaitMs = Math.max(0, Math.min(60_000, Number(urlWaitMs) || 0));
    const currentTab = boundedUrlWaitMs > 0
      ? await waitForTabUrl(tabId, url, boundedUrlWaitMs)
      : await chrome.tabs.get(tabId);

    if (!sessionManager.isTracked(tabId)) {
      try { await sessionManager.addTabToSession(tabId, "agent"); } catch { /* best-effort */ }
    }

    return {
      ok: sameUrlTarget(currentTab.url, url),
      tabId,
      created,
      initialUrl,
      navigationMethod: "chrome.tabs.update",
      url,
      observedUrl: currentTab.url ?? navigation.url ?? null,
      title: currentTab.title,
      identifier: preload.identifier ?? null,
      sourceChars: source.length,
      guidance: sameUrlTarget(currentTab.url, url)
        ? "Preload registered and tab navigated to the requested URL."
        : "Preload registered and chrome.tabs.update was sent, but the observed tab URL did not match before timeout.",
    };
  }
}
