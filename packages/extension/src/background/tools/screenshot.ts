import type { ScreenshotArgs } from "@webbridge/shared";
import { BaseTool, type ToolContext } from "./base.js";
import { resolveTabId } from "../../cdp/session.js";

interface CaptureResult {
  data: string;
}

export class ScreenshotTool extends BaseTool {
  readonly name = "screenshot" as const;
  readonly description = "Capture a screenshot of the current page";

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
    const {
      tabId: rawTabId,
      fullPage = false,
      format = "png",
      quality,
      clip,
    } = args as unknown as ScreenshotArgs;

    const tabId = await resolveTabId(rawTabId);

    await ctx.cdp.send(tabId, "Page.enable");

    const params: Record<string, unknown> = {
      format,
      ...(quality !== undefined && { quality }),
      ...(clip && { clip: { ...clip, scale: 1 } }),
    };

    if (fullPage) {
      const metrics = await ctx.cdp.send<{
        contentSize: { width: number; height: number };
      }>(tabId, "Page.getLayoutMetrics");

      if (metrics?.contentSize) {
        params.clip = {
          x: 0,
          y: 0,
          width: metrics.contentSize.width,
          height: metrics.contentSize.height,
          scale: 1,
        };
        params.captureBeyondViewport = true;
      }
    }

    const result = await ctx.cdp.send<CaptureResult>(
      tabId,
      "Page.captureScreenshot",
      params
    );

    return {
      tabId,
      data: result.data,
      format,
    };
  }
}
