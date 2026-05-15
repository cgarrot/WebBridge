import type { SnapshotArgs } from "@webbridge/shared";
import { BaseTool, type ToolContext } from "./base.js";
import { resolveTabId } from "../../cdp/session.js";

export class SnapshotTool extends BaseTool {
  readonly name = "snapshot" as const;
  readonly description = "Get a DOM or accessibility tree snapshot";

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
    const { tabId: rawTabId, type = "dom" } = args as unknown as SnapshotArgs;
    const tabId = await resolveTabId(rawTabId);

    if (type === "accessibility") {
      await ctx.cdp.send(tabId, "Accessibility.enable");
      const tree = await ctx.cdp.send<{ nodes: unknown[] }>(
        tabId,
        "Accessibility.getFullAXTree"
      );
      return { tabId, type: "accessibility", nodes: tree.nodes };
    }

    const result = await ctx.cdp.send<{
      result: { value: string };
    }>(tabId, "Runtime.evaluate", {
      expression: "document.documentElement.outerHTML",
      returnByValue: true,
    });

    return { tabId, type: "dom", html: result.result.value };
  }
}
