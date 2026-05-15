import type { FillArgs } from "@webbridge/shared";
import { BaseTool, type ToolContext } from "./base.js";
import { resolveTabId } from "../../cdp/session.js";

export class FillTool extends BaseTool {
  readonly name = "fill" as const;
  readonly description = "Fill a form field with the given value";

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
    const { tabId: rawTabId, selector, value } = args as unknown as FillArgs;

    if (!selector) throw new Error("fill: selector is required");
    if (value === undefined) throw new Error("fill: value is required");

    const tabId = await resolveTabId(rawTabId);

    await ctx.cdp.send(tabId, "Runtime.evaluate", {
      expression: `
        (() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) throw new Error('Element not found: ${selector}');
          el.focus();
          el.value = '';
        })()
      `,
      awaitPromise: true,
    });

    for (const char of value) {
      await ctx.cdp.send(tabId, "Input.dispatchKeyEvent", {
        type: "keyDown",
        text: char,
      });
      await ctx.cdp.send(tabId, "Input.dispatchKeyEvent", {
        type: "keyUp",
        text: char,
      });
    }

    await ctx.cdp.send(tabId, "Runtime.evaluate", {
      expression: `
        (() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (el) {
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
        })()
      `,
    });

    return { tabId, selector, filled: true };
  }
}
