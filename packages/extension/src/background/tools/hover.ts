import type { HoverArgs } from "@webbridge/shared";
import { BaseTool, type ToolContext } from "./base.js";
import { resolveTabId } from "../../cdp/session.js";
import { moveCursor } from "../../cdp/cursor.js";

export class HoverTool extends BaseTool {
  readonly name = "hover" as const;
  readonly description = "Move cursor to coordinates and hover (trigger CSS :hover)";

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
    const { x, y, duration = 500, tabId: rawTabId } = args as unknown as HoverArgs;

    if (x === undefined || y === undefined) {
      throw new Error("hover: x and y are required");
    }

    const tabId = await resolveTabId(rawTabId);

    await moveCursor(tabId, x, y, true);

    await ctx.cdp.send(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
    });

    if (duration > 0) {
      await new Promise((r) => setTimeout(r, duration));
    }

    return { tabId, x, y, duration };
  }
}
