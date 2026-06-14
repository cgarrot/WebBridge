import type { PreloadScriptArgs } from "@webbridge/shared";
import { BaseTool, type ToolContext } from "./base.js";
import { getActiveTabId, isBrowserInternalUrl, resolveTabId } from "../../cdp/session.js";

const MAX_PRELOAD_SOURCE_CHARS = 250_000;
const DEFAULT_PRELOAD_TARGET_URL = "data:text/html,%3Ctitle%3Ewebbridge-preload%3C/title%3E";

async function resolvePreloadTarget(rawTabId: number | undefined): Promise<{
  tabId: number;
  created: boolean;
  initialUrl: string | null;
  redirectedFrom: { tabId: number; url: string | null } | null;
}> {
  if (rawTabId != null) {
    const tabId = await resolveTabId(rawTabId);
    const tab = await chrome.tabs.get(tabId);
    if (isBrowserInternalUrl(tab.url)) {
      throw new Error(
        `preload_script: tab ${tabId} has a browser-internal URL (${tab.url}). ` +
        `Chrome does not allow CDP access to this page. Select a normal web page, navigate this tab first, or use preload_navigate with newTab=true.`
      );
    }
    return { tabId, created: false, initialUrl: null, redirectedFrom: null };
  }

  const activeTabId = await getActiveTabId();
  const activeTab = await chrome.tabs.get(activeTabId);
  if (!isBrowserInternalUrl(activeTab.url)) {
    return { tabId: activeTabId, created: false, initialUrl: null, redirectedFrom: null };
  }

  const tab = await chrome.tabs.create({ url: DEFAULT_PRELOAD_TARGET_URL, active: true });
  if (tab.id === undefined) throw new Error("preload_script: failed to create preload target tab");
  return {
    tabId: tab.id,
    created: true,
    initialUrl: DEFAULT_PRELOAD_TARGET_URL,
    redirectedFrom: { tabId: activeTabId, url: activeTab.url ?? null },
  };
}

function boundValue(value: unknown, maxChars: number): { value: unknown; chars: number; truncated: boolean } {
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  if (raw === undefined) return { value, chars: 0, truncated: false };
  if (raw.length <= maxChars) return { value, chars: raw.length, truncated: false };
  return {
    value: raw.slice(0, Math.max(0, maxChars - 1)) + "…",
    chars: raw.length,
    truncated: true,
  };
}

export class PreloadScriptTool extends BaseTool {
  readonly name = "preload_script" as const;
  readonly description = "Install a JavaScript preload script in a tab via CDP Page.addScriptToEvaluateOnNewDocument before navigation";

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
    const { tabId: rawTabId, source, isolated = false, register = true, runNow = false, maxChars } = args as unknown as PreloadScriptArgs;
    if (!source || typeof source !== "string") throw new Error("preload_script: source is required");
    if (source.length > MAX_PRELOAD_SOURCE_CHARS) {
      throw new Error(`preload_script: source is too large (${source.length} chars, max ${MAX_PRELOAD_SOURCE_CHARS})`);
    }

    if (!register && !runNow) throw new Error("preload_script: register=false requires runNow=true");
    const target = await resolvePreloadTarget(rawTabId);
    const tabId = target.tabId;
    await ctx.cdp.send(tabId, "Page.enable");
    let result: { identifier?: string } = {};
    if (register) {
      result = await ctx.cdp.send<{ identifier?: string }>(
        tabId,
        "Page.addScriptToEvaluateOnNewDocument",
        {
          source,
          ...(isolated ? { worldName: "webbridge_preload" } : {}),
        },
      );
    }

    let runNowResult: unknown = undefined;
    if (runNow) {
      const evaluated = await ctx.cdp.send<{
        result: { type: string; value?: unknown; description?: string };
        exceptionDetails?: { text: string };
      }>(tabId, "Runtime.evaluate", {
        expression: source,
        returnByValue: true,
        awaitPromise: true,
      });
      if (evaluated.exceptionDetails) {
        throw new Error(`preload_script runNow JS error: ${evaluated.exceptionDetails.text}`);
      }
      runNowResult = boundValue(
        evaluated.result.value ?? evaluated.result.description,
        typeof maxChars === "number" && Number.isFinite(maxChars) && maxChars > 0
          ? Math.max(100, Math.min(100_000, Math.floor(maxChars)))
          : 10_000,
      );
    }

    return {
      ok: true,
      tabId,
      identifier: result.identifier ?? null,
      sourceChars: source.length,
      isolated,
      register,
      runNow,
      runNowResult,
      created: target.created,
      initialUrl: target.initialUrl,
      redirectedFrom: target.redirectedFrom,
      guidance: target.created
        ? "Active tab was browser-internal and cannot be controlled by CDP, so WebBridge created a safe preload target tab. Navigate this new tab to the target URL after this call, or use preload_navigate with newTab=true."
        : runNow
          ? (register ? "Preload registered for future navigations and executed in the current document." : "Script executed in the current document without registering for future navigations.")
          : "Preload registered for future navigations in this tab. Navigate the same tab to the target URL after this call.",
    };
  }
}
