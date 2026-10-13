import type { NavigateArgs } from "@webbridge/shared";
import { BaseTool, type ToolContext } from "./base.js";
import { resolveTabId } from "../../cdp/session.js";
import { sessionManager } from "../session-manager.js";
import { resolveLoadStrategy, waitForLoad, type WaitUntil } from "../../cdp/load.js";

function originOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export class NavigateTool extends BaseTool {
  readonly name = "navigate" as const;
  readonly description =
    "Navigate a tab to the given URL. Reuses an existing session tab by default (newTab:true); pass forceNewTab:true to force a brand-new tab.";

  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<unknown> {
    const {
      url,
      tabId: rawTabId,
      newTab = false,
      forceNewTab = false,
      group_title,
      groupTitle,
      waitUntil,
    } = args as unknown as NavigateArgs;
    if (!url) throw new Error("navigate: url is required");

    const sessionTitle = groupTitle ?? group_title;
    if (sessionTitle) {
      await sessionManager.nameSession(sessionTitle);
    }

    let tabId: number;
    let created = false;
    let reused = false;
    let closedDueToCap: number[] = [];

    if (newTab) {
      // Create-or-reuse: retries no longer stack tabs.
      const acquired = await sessionManager.acquireTab({
        url,
        newTab: true,
        forceNewTab,
        preferOrigin: originOf(url) ?? undefined,
        active: true,
      });
      tabId = acquired.tabId;
      created = acquired.created;
      reused = acquired.reused;
      closedDueToCap = acquired.closedDueToCap;
      if (reused) {
        // Reused tab: navigate it to the requested URL.
        await chrome.tabs.update(tabId, { url, active: true });
      }
    } else {
      tabId = await resolveTabId(rawTabId);
      await chrome.tabs.update(tabId, { url, active: true });
      if (!sessionManager.isTracked(tabId)) {
        try {
          await sessionManager.addTabToSession(tabId, "agent");
        } catch {
          // best-effort
        }
      }
    }

    sessionManager.setPrimary(tabId);

    // Reliable, bounded load wait. Non-fatal on timeout (returns loaded:false)
    // so we always respond before the caller aborts and retries.
    const strategy = resolveLoadStrategy(waitUntil as WaitUntil | undefined);
    let loadResult;
    try {
      loadResult = await waitForLoad(tabId, strategy);
    } catch (err) {
      loadResult = {
        loaded: false,
        strategy: strategy.kind,
        elapsedMs: 0,
        reason: err instanceof Error ? err.message : String(err),
      };
    }

    const currentTab = await chrome.tabs.get(tabId);

    return {
      tabId,
      url: currentTab.url ?? url,
      title: currentTab.title,
      created,
      reused,
      closedDueToCap: closedDueToCap.length ? closedDueToCap : undefined,
      loaded: loadResult.loaded,
      loadStrategy: loadResult.strategy,
      loadReason: loadResult.reason,
    };
  }
}
