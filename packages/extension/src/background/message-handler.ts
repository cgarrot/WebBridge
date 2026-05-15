import {
  createToolResult,
  EXTENSION_VERSION,
  type BridgeMessage,
  type ToolCallMessage,
} from "@webbridge/shared";
import type { ITransport } from "./transport/interface.js";
import { toolRegistry } from "./tools/registry.js";
import { cdpBridge } from "../cdp/bridge.js";

export class MessageHandler {
  constructor(private transport: ITransport) {}

  handle(message: BridgeMessage): void {
    switch (message.type) {
      case "hello_ack":
        console.log("[WebBridge] Connected to daemon:", message.payload.daemonVersion);
        break;

      case "ping":
        this.transport.send({ type: "pong", timestamp: message.timestamp });
        break;

      case "tool_call":
        this.handleToolCall(message);
        break;

      default:
        console.warn("[WebBridge] Unknown message type:", (message as BridgeMessage).type);
    }
  }

  private async handleToolCall(message: ToolCallMessage): Promise<void> {
    const { requestId, payload } = message;
    const { name, args } = payload;

    try {
      const result = await toolRegistry.dispatch(name, args, { cdp: cdpBridge });
      this.transport.send(createToolResult(requestId, result));
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[WebBridge] Tool "${name}" failed:`, errorMsg);
      this.transport.send(createToolResult(requestId, undefined, errorMsg));
    }
  }

  sendHello(): void {
    this.transport.send({
      type: "hello",
      payload: {
        extensionVersion: EXTENSION_VERSION,
        capabilities: toolRegistry.listTools().map((t) => t.name),
      },
    });
  }
}
