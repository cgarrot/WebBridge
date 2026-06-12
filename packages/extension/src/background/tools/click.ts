import type { ClickArgs } from "@webbridge/shared";
import { BaseTool, type ToolContext } from "./base.js";
import { resolveTabId } from "../../cdp/session.js";
import { moveCursor, cursorClickEffect } from "../../cdp/cursor.js";
import { resolveElementRef } from "../element-ref-store.js";

const BUTTON_MAP: Record<string, number> = { left: 0, middle: 1, right: 2 };

export class ClickTool extends BaseTool {
  readonly name = "click" as const;
  readonly description = "Click at coordinates or a CSS selector on the page with visible cursor";

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
    const {
      tabId: rawTabId,
      selector,
      button = "left",
      clickCount = 1,
    } = args as unknown as ClickArgs;
    let { x, y } = args as unknown as ClickArgs;

    const tabId = await resolveTabId(rawTabId);

    if ((x === undefined || y === undefined) && selector?.startsWith("@e")) {
      const backendNodeId = resolveElementRef(tabId, selector);
      if (backendNodeId === undefined) {
        throw new Error(`click: stale or unknown element ref: ${selector}. Refresh snapshot first.`);
      }
      const boxModel = await ctx.cdp.send<{
        model: { content: [number, number, number, number, number, number, number, number] };
      }>(tabId, "DOM.getBoxModel", { backendNodeId });
      const quad = boxModel.model.content;
      x = Math.round((quad[0] + quad[2] + quad[4] + quad[6]) / 4);
      y = Math.round((quad[1] + quad[3] + quad[5] + quad[7]) / 4);
    }

    if ((x === undefined || y === undefined) && selector) {
      const result = await ctx.cdp.send<{ result: { value?: { x: number; y: number } } }>(
        tabId,
        "Runtime.evaluate",
        {
          expression: `(() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) throw new Error('Element not found: ${selector.replace(/'/g, "\\'")}');
            el.scrollIntoView({ block: 'center', inline: 'center' });
            const rect = el.getBoundingClientRect();
            return {
              x: Math.round(rect.left + rect.width / 2),
              y: Math.round(rect.top + rect.height / 2),
            };
          })()`,
          returnByValue: true,
          awaitPromise: true,
        },
      );
      x = result.result.value?.x;
      y = result.result.value?.y;
    }

    if (x === undefined || y === undefined) {
      throw new Error("click: x/y coordinates or selector are required");
    }

    const cdpButton = BUTTON_MAP[button] ?? 0;

    await moveCursor(tabId, x, y, true);
    await cursorClickEffect(tabId, x, y);

    await ctx.cdp.send(tabId, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button,
      clickCount,
      buttons: 1 << cdpButton,
    });

    await ctx.cdp.send(tabId, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button,
      clickCount,
    });

    return { tabId, selector, x, y, button, clickCount };
  }
}
