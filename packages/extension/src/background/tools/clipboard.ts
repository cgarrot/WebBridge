import type { ClipboardArgs } from "@webbridge/shared";
import { BaseTool, type ToolContext } from "./base.js";
import { resolveTabId } from "../../cdp/session.js";

export class ClipboardTool extends BaseTool {
  readonly name = "clipboard" as const;
  readonly description = "Read or write the browser clipboard";

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
    const { action, text, tabId: rawTabId } = args as unknown as ClipboardArgs;
    if (!action) throw new Error("clipboard: action ('read' or 'write') is required");

    const tabId = await resolveTabId(rawTabId);

    if (action === "write") {
      if (text === undefined) throw new Error("clipboard: text is required for write");

      await ctx.cdp.send(tabId, "Runtime.evaluate", {
        expression: `navigator.clipboard.writeText(${JSON.stringify(text)})`,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      });
      return { tabId, action: "write", length: text.length };
    }

    const result = await ctx.cdp.send<{
      result: { value: string };
      exceptionDetails?: { text: string };
    }>(tabId, "Runtime.evaluate", {
      expression: "navigator.clipboard.readText()",
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });

    if (result.exceptionDetails) {
      throw new Error(`clipboard read failed: ${result.exceptionDetails.text}`);
    }

    return { tabId, action: "read", text: result.result.value ?? "" };
  }
}
