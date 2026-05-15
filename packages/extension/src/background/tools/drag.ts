import type { DragArgs } from "@webbridge/shared";
import { BaseTool, type ToolContext } from "./base.js";
import { resolveTabId } from "../../cdp/session.js";
import { moveCursor } from "../../cdp/cursor.js";

export class DragTool extends BaseTool {
  readonly name = "drag" as const;
  readonly description = "Drag from start to end along a path of coordinates";

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
    const { path, tabId: rawTabId } = args as unknown as DragArgs;

    if (!path || path.length < 2) {
      throw new Error("drag: path must have at least 2 points [{x,y}, ...]");
    }

    const tabId = await resolveTabId(rawTabId);
    const start = path[0];
    const end = path[path.length - 1];

    await moveCursor(tabId, start.x, start.y, true);

    await ctx.cdp.send(tabId, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: start.x,
      y: start.y,
      button: "left",
      clickCount: 1,
      buttons: 1,
    });

    for (let i = 1; i < path.length; i++) {
      const p = path[i];
      await moveCursor(tabId, p.x, p.y, false);
      await ctx.cdp.send(tabId, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: p.x,
        y: p.y,
        buttons: 1,
      });
    }

    await ctx.cdp.send(tabId, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: end.x,
      y: end.y,
      button: "left",
    });

    return { tabId, from: start, to: end, steps: path.length };
  }
}
