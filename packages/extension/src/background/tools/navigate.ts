import type { NavigateArgs } from "@webbridge/shared";
import { BaseTool, type ToolContext } from "./base.js";
import { resolveTabId, waitForPageLoad } from "../../cdp/session.js";

export class NavigateTool extends BaseTool {
  readonly name = "navigate" as const;
  readonly description = "Navigate a tab to the given URL";

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
    const { url, tabId: rawTabId, waitUntil } = args as unknown as NavigateArgs;
    if (!url) throw new Error("navigate: url is required");

    const tabId = await resolveTabId(rawTabId);

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

    return {
      tabId,
      url: currentUrl?.result?.value ?? url,
    };
  }
}
