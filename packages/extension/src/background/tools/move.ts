import type { MoveArgs } from "@webbridge/shared";
import { BaseTool, type ToolContext } from "./base.js";
import { resolveTabId } from "../../cdp/session.js";
import { moveCursor } from "../../cdp/cursor.js";

export class MoveTool extends BaseTool {
  readonly name = "move" as const;
  readonly description = "Move the visible cursor to coordinates";

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
    const { x, y, tabId: rawTabId } = args as unknown as MoveArgs;
    if (x === undefined || y === undefined) {
      throw new Error("move: x and y are required");
    }

    const tabId = await resolveTabId(rawTabId);
    await moveCursor(tabId, x, y, true);

    await ctx.cdp.send(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
    });

    return { tabId, x, y };
  }
}
