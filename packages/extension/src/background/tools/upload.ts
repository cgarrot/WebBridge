import type { UploadArgs } from "@webbridge/shared";
import { BaseTool, type ToolContext } from "./base.js";
import { resolveTabId } from "../../cdp/session.js";

export class UploadTool extends BaseTool {
  readonly name = "upload" as const;
  readonly description = "Upload files to a file input element";

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
    const { tabId: rawTabId, selector, filePaths } = args as unknown as UploadArgs;

    if (!selector) throw new Error("upload: selector is required");
    if (!filePaths?.length) throw new Error("upload: filePaths array is required");

    const tabId = await resolveTabId(rawTabId);

    await ctx.cdp.send(tabId, "DOM.enable");
    const doc = await ctx.cdp.send<{ root: { nodeId: number } }>(
      tabId,
      "DOM.getDocument"
    );

    const node = await ctx.cdp.send<{ nodeId: number }>(
      tabId,
      "DOM.querySelector",
      { nodeId: doc.root.nodeId, selector }
    );

    if (!node.nodeId) {
      throw new Error(`upload: element not found: ${selector}`);
    }

    await ctx.cdp.send(tabId, "DOM.setFileInputFiles", {
      nodeId: node.nodeId,
      files: filePaths,
    });

    return { tabId, selector, filesUploaded: filePaths.length };
  }
}
