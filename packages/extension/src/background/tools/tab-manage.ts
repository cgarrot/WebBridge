import type { ListTabsArgs, CloseTabArgs, FindTabArgs } from "@webbridge/shared";
import { BaseTool, type ToolContext } from "./base.js";

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
