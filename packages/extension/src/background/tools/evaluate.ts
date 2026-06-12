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
      maxChars,
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

    const value = result.result.value ?? result.result.description;
    if (typeof maxChars === "number" && Number.isFinite(maxChars) && maxChars > 0) {
      const bounded = boundValue(value, Math.max(100, Math.min(100_000, Math.floor(maxChars))));
      return {
        tabId,
        type: result.result.type,
        value: bounded.value,
        chars: bounded.chars,
        truncated: bounded.truncated,
      };
    }

    return {
      tabId,
      type: result.result.type,
      value,
    };
  }
}

function boundValue(value: unknown, maxChars: number): { value: unknown; chars: number; truncated: boolean } {
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  if (raw === undefined) return { value, chars: 0, truncated: false };
  if (raw.length <= maxChars) return { value, chars: raw.length, truncated: false };
  return {
    value: raw.slice(0, Math.max(0, maxChars - 1)) + "…",
    chars: raw.length,
    truncated: true,
  };
}
