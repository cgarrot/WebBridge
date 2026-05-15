import type { ToolName } from "@webbridge/shared";
import type { BaseTool, ToolContext } from "./base.js";

export class ToolRegistry {
  private tools = new Map<string, BaseTool>();

  register(tool: BaseTool): void {
    if (this.tools.has(tool.name)) {
      console.warn(`[WebBridge] Tool "${tool.name}" already registered, overwriting`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): BaseTool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  async dispatch(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext
  ): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Unknown tool: ${name}`);
    }
    return tool.execute(args, ctx);
  }

  listTools(): Array<{ name: ToolName; description: string }> {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
    }));
  }
}

export const toolRegistry = new ToolRegistry();
