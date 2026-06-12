import type { NavigateArgs } from "@webbridge/shared";
import { BaseTool, type ToolContext } from "./base.js";
import { resolveTabId, waitForPageLoad } from "../../cdp/session.js";
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
      const tab = await chrome.tabs.create({ url: "about:blank", active: true });
      if (tab.id === undefined) throw new Error("navigate: failed to create new tab");
      tabId = tab.id;
    } else {
      tabId = await resolveTabId(rawTabId);
    }

    await ctx.cdp.send(tabId, "Page.enable");
    await ctx.cdp.send(tabId, "Page.navigate", { url });

    if (waitUntil !== "domcontentloaded") {
      try {
        await waitForPageLoad(tabId);
      } catch {
        // timeout is non-fatal for navigation
      }
    }

    const currentUrl = await ctx.cdp.send<{ result: { value: string } }>(
      tabId,
      "Runtime.evaluate",
      { expression: "location.href", returnByValue: true }
    );

    if (!sessionManager.isTracked(tabId)) {
      try {
        await sessionManager.addTabToSession(tabId, "agent");
      } catch {
        // best-effort
      }
    }

    return {
      tabId,
      url: currentUrl?.result?.value ?? url,
    };
  }
}
