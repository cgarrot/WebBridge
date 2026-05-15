import type { ConsoleLogsArgs } from "@webbridge/shared";
import { BaseTool, type ToolContext } from "./base.js";
import { resolveTabId } from "../../cdp/session.js";
import { consoleCapture } from "../../cdp/console-capture.js";

export class ConsoleLogsTool extends BaseTool {
  readonly name = "console_logs" as const;
  readonly description = "Capture and retrieve browser console logs";

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
    const {
      tabId: rawTabId,
      levels,
      filter,
      limit = 50,
    } = args as unknown as ConsoleLogsArgs;

    const tabId = await resolveTabId(rawTabId);

    await consoleCapture.enable(tabId);

    const entries = consoleCapture.getEntries(tabId, { levels, filter, limit });

    return { tabId, count: entries.length, entries };
  }
}
