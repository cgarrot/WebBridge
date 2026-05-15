import type {
  NameSessionArgs,
  FinalizeTabsArgs,
  ClaimTabArgs,
  BrowserHistoryArgs,
} from "@webbridge/shared";
import { BaseTool, type ToolContext } from "./base.js";
import { sessionManager } from "../session-manager.js";

export class NameSessionTool extends BaseTool {
  readonly name = "name_session" as const;
  readonly description =
    "Name the current browser automation session. Agent-created tabs will be grouped under this name.";

  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<unknown> {
    const { name } = args as unknown as NameSessionArgs;
    if (!name) throw new Error("name_session: name is required");

    const result = sessionManager.nameSession(name);
    return { session: await result };
  }
}

export class FinalizeTabsTool extends BaseTool {
  readonly name = "finalize_tabs" as const;
  readonly description =
    "Finalize the session: close agent-created intermediate tabs, keep deliverable/handoff tabs. Call at the end of browser work.";

  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<unknown> {
    const { keep = [] } = args as unknown as FinalizeTabsArgs;
    const result = await sessionManager.finalize(keep);
    return result;
  }
}

export class ClaimTabTool extends BaseTool {
  readonly name = "claim_tab" as const;
  readonly description =
    "Claim a user-owned tab into the current session's tab group for agent control.";

  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<unknown> {
    const { tabId } = args as unknown as ClaimTabArgs;
    if (tabId === undefined) throw new Error("claim_tab: tabId is required");

    const tab = await sessionManager.claimTab(tabId);
    return {
      id: tab.id,
      title: tab.title,
      url: tab.url,
      active: true,
    };
  }
}

export class BrowserHistoryTool extends BaseTool {
  readonly name = "browser_history" as const;
  readonly description =
    "Search browser history by keyword and/or time range.";

  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<unknown> {
    const { query, from, to, limit = 50 } = args as unknown as BrowserHistoryArgs;

    const searchParams: chrome.history.SearchQuery = {
      text: query ?? "",
      maxResults: Math.min(limit, 200),
    };

    if (from) searchParams.startTime = new Date(from).getTime();
    if (to) searchParams.endTime = new Date(to).getTime();

    const results = await chrome.history.search(searchParams);

    return results.map((item) => ({
      url: item.url,
      title: item.title,
      lastVisitTime: item.lastVisitTime
        ? new Date(item.lastVisitTime).toISOString()
        : undefined,
      visitCount: item.visitCount,
    }));
  }
}
