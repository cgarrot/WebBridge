import type { SaveAsPdfArgs } from "@webbridge/shared";
import { BaseTool, type ToolContext } from "./base.js";
import { resolveTabId } from "../../cdp/session.js";

export class SaveAsPdfTool extends BaseTool {
  readonly name = "save_as_pdf" as const;
  readonly description = "Export the current page as PDF";

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
    const {
      tabId: rawTabId,
      landscape = false,
      printBackground = true,
    } = args as unknown as SaveAsPdfArgs;

    const tabId = await resolveTabId(rawTabId);

    const result = await ctx.cdp.send<{ data: string }>(
      tabId,
      "Page.printToPDF",
      { landscape, printBackground }
    );

    return { tabId, data: result.data, format: "pdf" };
  }
}
