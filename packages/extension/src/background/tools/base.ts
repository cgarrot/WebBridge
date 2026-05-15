import type { ToolName } from "@webbridge/shared";
import type { CDPBridge } from "../../cdp/bridge.js";

export interface ToolContext {
  cdp: CDPBridge;
}

export abstract class BaseTool {
  abstract readonly name: ToolName;
  abstract readonly description: string;

  abstract execute(
    args: Record<string, unknown>,
    ctx: ToolContext
  ): Promise<unknown>;
}
