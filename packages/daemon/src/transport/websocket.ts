import type { WebSocket } from "ws";
import type { BridgeMessage } from "@webbridge/shared";
import type {
  IDaemonTransport,
  TransportMessageHandler,
  TransportCloseHandler,
} from "./interface.js";

export class WebSocketDaemonTransport implements IDaemonTransport {
  private messageHandlers = new Set<TransportMessageHandler>();
  private closeHandlers = new Set<TransportCloseHandler>();

  constructor(private ws: WebSocket) {
    ws.on("message", (data: Buffer | string) => {
      try {
        const msg = JSON.parse(data.toString()) as BridgeMessage;
        this.messageHandlers.forEach((h) => h(msg));
      } catch {
        console.error("[WS] Invalid message received");
      }
    });

    ws.on("close", () => {
      this.closeHandlers.forEach((h) => h());
    });

    ws.on("error", (err) => {
      console.error("[WS] Connection error:", err.message);
    });
  }

  send(message: BridgeMessage): void {
    if (this.ws.readyState === this.ws.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  onMessage(handler: TransportMessageHandler): void {
    this.messageHandlers.add(handler);
  }

  onClose(handler: TransportCloseHandler): void {
    this.closeHandlers.add(handler);
  }

  close(): void {
    this.ws.close();
  }
}
