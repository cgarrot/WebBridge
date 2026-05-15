import type { EvaluateArgs } from "@webbridge/shared";
import { BaseTool, type ToolContext } from "./base.js";
import { resolveTabId } from "../../cdp/session.js";

export class EvaluateTool extends BaseTool {
  readonly name = "evaluate" as const;
  readonly description = "Execute JavaScript in the page context";

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
    const {
      tabId: rawTabId,
      expression,
      returnByValue = true,
    } = args as unknown as EvaluateArgs;

    if (!expression) throw new Error("evaluate: expression is required");

    const tabId = await resolveTabId(rawTabId);

    const result = await ctx.cdp.send<{
      result: { type: string; value?: unknown; description?: string };
      exceptionDetails?: { text: string };
    }>(tabId, "Runtime.evaluate", {
      expression,
      returnByValue,
      awaitPromise: true,
    });

    if (result.exceptionDetails) {
      throw new Error(`JS error: ${result.exceptionDetails.text}`);
    }

    return {
      tabId,
      type: result.result.type,
      value: result.result.value ?? result.result.description,
    };
  }
}
