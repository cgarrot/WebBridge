import type { ReloadExtensionArgs } from "@webbridge/shared";
import { BaseTool, type ToolContext } from "./base.js";

export class ReloadExtensionTool extends BaseTool {
  readonly name = "reload_extension" as const;
  readonly description = "Reload the WebBridge Chrome extension service worker from disk";

  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<unknown> {
    const { delayMs = 250 } = args as unknown as ReloadExtensionArgs;
    const boundedDelayMs = Math.max(50, Math.min(5_000, Math.floor(delayMs)));

    setTimeout(() => {
      chrome.runtime.reload();
    }, boundedDelayMs);

    return {
      reloading: true,
      delayMs: boundedDelayMs,
      note: "The extension will disconnect briefly and reconnect if the daemon is running.",
    };
  }
}
