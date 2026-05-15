import type { ScrollArgs } from "@webbridge/shared";
import { BaseTool, type ToolContext } from "./base.js";
import { resolveTabId } from "../../cdp/session.js";
import { moveCursor } from "../../cdp/cursor.js";

export class ScrollTool extends BaseTool {
  readonly name = "scroll" as const;
  readonly description = "Scroll the page at given coordinates";

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
    const {
      x,
      y,
      deltaX = 0,
      deltaY = -300,
      tabId: rawTabId,
    } = args as unknown as ScrollArgs;

    if (x === undefined || y === undefined) {
      throw new Error("scroll: x and y are required");
    }

    const tabId = await resolveTabId(rawTabId);

    await moveCursor(tabId, x, y, true);

    await ctx.cdp.send(tabId, "Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x,
      y,
      deltaX,
      deltaY,
    });

    return { tabId, x, y, deltaX, deltaY };
  }
}
