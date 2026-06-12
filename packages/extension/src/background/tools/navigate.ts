import type { NavigateArgs } from "@webbridge/shared";
import { BaseTool, type ToolContext } from "./base.js";
import { resolveTabId } from "../../cdp/session.js";
import { sessionManager } from "../session-manager.js";

export class NavigateTool extends BaseTool {
  readonly name = "navigate" as const;
  readonly description = "Navigate a tab to the given URL";

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
    const {
      url,
      tabId: rawTabId,
      newTab = false,
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
    if (newTab) {
      const tab = await chrome.tabs.create({ url, active: true });
      if (tab.id === undefined) throw new Error("navigate: failed to create new tab");
      tabId = tab.id;
    } else {
      tabId = await resolveTabId(rawTabId);
      await chrome.tabs.update(tabId, { url, active: true });
    }

    if (waitUntil !== "domcontentloaded") {
      try {
        await waitForTabComplete(tabId);
      } catch {
        // timeout is non-fatal for navigation
      }
    }

    const currentTab = await chrome.tabs.get(tabId);

    if (!sessionManager.isTracked(tabId)) {
      try {
        await sessionManager.addTabToSession(tabId, "agent");
      } catch {
        // best-effort
      }
    }

    return {
      tabId,
      url: currentTab.url ?? url,
      title: currentTab.title,
    };
  }
}

function waitForTabComplete(tabId: number, timeoutMs = 30_000): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      if (error) reject(error);
      else resolve();
    };

    const timer = setTimeout(() => finish(new Error(`Page load timeout after ${timeoutMs}ms`)), timeoutMs);
    const listener = (updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") finish();
    };
    chrome.tabs.onUpdated.addListener(listener);

    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === "complete") finish();
    }).catch((error) => finish(error instanceof Error ? error : new Error(String(error))));
  });
}
