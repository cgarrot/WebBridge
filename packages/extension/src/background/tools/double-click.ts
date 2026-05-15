import type { DoubleClickArgs } from "@webbridge/shared";
import { BaseTool, type ToolContext } from "./base.js";
import { resolveTabId } from "../../cdp/session.js";
import { moveCursor, cursorClickEffect } from "../../cdp/cursor.js";

const BUTTON_MAP: Record<string, number> = { left: 0, middle: 1, right: 2 };

export class DoubleClickTool extends BaseTool {
  readonly name = "double_click" as const;
  readonly description = "Double-click at coordinates on the page";

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
    const { x, y, button = "left", tabId: rawTabId } = args as unknown as DoubleClickArgs;

    if (x === undefined || y === undefined) {
      throw new Error("double_click: x and y are required");
    }

    const tabId = await resolveTabId(rawTabId);
    const cdpButton = BUTTON_MAP[button] ?? 0;

    await moveCursor(tabId, x, y, true);
    await cursorClickEffect(tabId, x, y);

    for (let i = 1; i <= 2; i++) {
      await ctx.cdp.send(tabId, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        x,
        y,
        button,
        clickCount: i,
        buttons: 1 << cdpButton,
      });
      await ctx.cdp.send(tabId, "Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x,
        y,
        button,
        clickCount: i,
      });
    }

    return { tabId, x, y, button, clickCount: 2 };
  }
}
