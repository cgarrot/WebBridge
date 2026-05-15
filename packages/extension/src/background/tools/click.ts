import type { ClickArgs } from "@webbridge/shared";
import { BaseTool, type ToolContext } from "./base.js";
import { resolveTabId } from "../../cdp/session.js";

const BUTTON_MAP: Record<string, number> = { left: 0, middle: 1, right: 2 };

export class ClickTool extends BaseTool {
  readonly name = "click" as const;
  readonly description = "Click at coordinates on the page";

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
    const {
      tabId: rawTabId,
      x,
      y,
      button = "left",
      clickCount = 1,
    } = args as unknown as ClickArgs;

    if (x === undefined || y === undefined) {
      throw new Error("click: x and y are required");
    }

    const tabId = await resolveTabId(rawTabId);
    const cdpButton = BUTTON_MAP[button] ?? 0;

    await ctx.cdp.send(tabId, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: button,
      clickCount,
      buttons: 1 << cdpButton,
    });

    await ctx.cdp.send(tabId, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: button,
      clickCount,
    });

    return { tabId, x, y, button, clickCount };
  }
}
