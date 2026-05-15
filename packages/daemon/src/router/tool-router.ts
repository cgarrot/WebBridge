import { createToolCall, type BridgeMessage, type ToolResultMessage } from "@webbridge/shared";
import type { ConnectionManager } from "../connection/manager.js";
import type { DaemonConfig } from "../config/index.js";
import { randomUUID } from "crypto";

interface PendingCall {
  resolve: (result: ToolResultMessage["payload"]) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ToolRouter {
  private pending = new Map<string, PendingCall>();

  constructor(
    private connectionManager: ConnectionManager,
    private config: DaemonConfig
  ) {
    this.connectionManager.onMessage((msg) => {
      if (msg.type === "tool_result") {
        this.handleResult(msg);
      }
    });
  }

  async callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<ToolResultMessage["payload"]> {
    const transport = this.connectionManager.getActiveTransport();
    if (!transport) {
      throw new Error("No extension connected");
    }

    const requestId = randomUUID();
    const message = createToolCall(requestId, name, args);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Tool call "${name}" timed out after ${this.config.toolCallTimeoutMs}ms`));
      }, this.config.toolCallTimeoutMs);

      this.pending.set(requestId, { resolve, reject, timer });
      transport.send(message);
    });
  }

  private handleResult(msg: ToolResultMessage): void {
    const pending = this.pending.get(msg.responseToRequestId);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pending.delete(msg.responseToRequestId);
    pending.resolve(msg.payload);
  }
}
