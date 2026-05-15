import type {
  ListTabsArgs,
  CloseTabArgs,
  FindTabArgs,
  NewTabArgs,
  SwitchTabArgs,
  GetTabInfoArgs,
} from "@webbridge/shared";
import { BaseTool, type ToolContext } from "./base.js";
import { resolveTabId } from "../../cdp/session.js";
import { sessionManager } from "../session-manager.js";

export class ListTabsTool extends BaseTool {
  readonly name = "list_tabs" as const;
  readonly description = "List all open browser tabs";

  async execute(
    _args: Record<string, unknown>,
    _ctx: ToolContext
  ): Promise<unknown> {
    const tabs = await chrome.tabs.query({});
    return tabs.map((tab) => ({
      id: tab.id,
      title: tab.title,
      url: tab.url,
      active: tab.active,
      windowId: tab.windowId,
    }));
  }
}

export class CloseTabTool extends BaseTool {
  readonly name = "close_tab" as const;
  readonly description = "Close a browser tab by ID";

  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<unknown> {
    const { tabId } = args as unknown as CloseTabArgs;
    if (tabId === undefined) throw new Error("close_tab: tabId is required");

    await chrome.tabs.remove(tabId);
    return { closed: true, tabId };
  }
}

export class FindTabTool extends BaseTool {
  readonly name = "find_tab" as const;
  readonly description = "Find tabs by title or URL query";

  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<unknown> {
    const { query, url } = args as unknown as FindTabArgs;

    const queryOptions: chrome.tabs.QueryInfo = {};
    if (url) queryOptions.url = url;

    let tabs = await chrome.tabs.query(queryOptions);

    if (query) {
      const q = query.toLowerCase();
      tabs = tabs.filter(
        (t) =>
          t.title?.toLowerCase().includes(q) ||
          t.url?.toLowerCase().includes(q)
      );
    }

    return tabs.map((tab) => ({
      id: tab.id,
      title: tab.title,
      url: tab.url,
      active: tab.active,
    }));
  }
}

export class NewTabTool extends BaseTool {
  readonly name = "new_tab" as const;
  readonly description = "Create a new browser tab";

  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<unknown> {
    const { url, active = true } = args as unknown as NewTabArgs;

    const tab = await chrome.tabs.create({
      url: url || "about:blank",
      active,
    });

    if (tab.id !== undefined) {
      try {
        await sessionManager.addTabToSession(tab.id, "agent");
      } catch {
        // Tab grouping is best-effort; don't fail the tool
      }
    }

    return {
      id: tab.id,
      title: tab.title,
      url: tab.url ?? tab.pendingUrl,
      active: tab.active,
      windowId: tab.windowId,
    };
  }
}

export class SwitchTabTool extends BaseTool {
  readonly name = "switch_tab" as const;
  readonly description = "Switch to (activate) a tab by ID";

  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<unknown> {
    const { tabId } = args as unknown as SwitchTabArgs;
    if (tabId === undefined) throw new Error("switch_tab: tabId is required");

    const tab = await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId!, { focused: true });

    return {
      id: tab.id,
      title: tab.title,
      url: tab.url,
      active: true,
    };
  }
}

export class GetTabInfoTool extends BaseTool {
  readonly name = "get_tab_info" as const;
  readonly description = "Get detailed info about a tab (url, title, status)";

  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<unknown> {
    const { tabId: rawTabId } = args as unknown as GetTabInfoArgs;
    const tabId = await resolveTabId(rawTabId);

    const tab = await chrome.tabs.get(tabId);
    return {
      id: tab.id,
      title: tab.title,
      url: tab.url,
      status: tab.status,
      active: tab.active,
      windowId: tab.windowId,
      favIconUrl: tab.favIconUrl,
    };
  }
}
