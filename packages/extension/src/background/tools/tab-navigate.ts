import type { BackArgs, ForwardArgs, ReloadArgs } from "@webbridge/shared";
import { BaseTool, type ToolContext } from "./base.js";
import { resolveTabId } from "../../cdp/session.js";

export class BackTool extends BaseTool {
  readonly name = "back" as const;
  readonly description = "Navigate the tab back in history";

  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<unknown> {
    const { tabId: rawTabId } = args as unknown as BackArgs;
    const tabId = await resolveTabId(rawTabId);

    try {
      await chrome.tabs.goBack(tabId);
    } catch {
      return { tabId, success: false, reason: "No previous page in history" };
    }
    await new Promise((r) => setTimeout(r, 500));

    const tab = await chrome.tabs.get(tabId);
    return { tabId, success: true, url: tab.url, title: tab.title };
  }
}

export class ForwardTool extends BaseTool {
  readonly name = "forward" as const;
  readonly description = "Navigate the tab forward in history";

  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<unknown> {
    const { tabId: rawTabId } = args as unknown as ForwardArgs;
    const tabId = await resolveTabId(rawTabId);

    try {
      await chrome.tabs.goForward(tabId);
    } catch {
      return { tabId, success: false, reason: "No next page in history" };
    }
    await new Promise((r) => setTimeout(r, 500));

    const tab = await chrome.tabs.get(tabId);
    return { tabId, success: true, url: tab.url, title: tab.title };
  }
}

export class ReloadTool extends BaseTool {
  readonly name = "reload" as const;
  readonly description = "Reload the current tab";

  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<unknown> {
    const { tabId: rawTabId, ignoreCache = false } = args as unknown as ReloadArgs;
    const tabId = await resolveTabId(rawTabId);

    await chrome.tabs.reload(tabId, { bypassCache: ignoreCache });
    await new Promise((r) => setTimeout(r, 1000));

    const tab = await chrome.tabs.get(tabId);
    return { tabId, url: tab.url, title: tab.title, status: tab.status };
  }
}
