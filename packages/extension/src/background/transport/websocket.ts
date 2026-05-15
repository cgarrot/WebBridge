import {
  DEFAULT_WS_HOST,
  DEFAULT_WS_PORT,
  type BridgeMessage,
} from "@webbridge/shared";
import type {
  ITransport,
  MessageHandler,
  StatusHandler,
  TransportStatus,
} from "./interface.js";

export interface WebSocketTransportOptions {
  host?: string;
  port?: number;
  path?: string;
}

export class WebSocketTransport implements ITransport {
  private ws: WebSocket | null = null;
  private messageHandlers = new Set<MessageHandler>();
  private statusHandlers = new Set<StatusHandler>();
  private _status: TransportStatus = "disconnected";

  private readonly url: string;

  constructor(options: WebSocketTransportOptions = {}) {
    const host = options.host ?? DEFAULT_WS_HOST;
    const port = options.port ?? DEFAULT_WS_PORT;
    const path = options.path ?? "/ws";
    this.url = `ws://${host}:${port}${path}`;
  }

  get status(): TransportStatus {
    return this._status;
  }

  connect(): Promise<void> {
    if (this._status === "connected") return Promise.resolve();

    this.setStatus("connecting");
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);

      ws.onopen = () => {
        this.ws = ws;
        this.setStatus("connected");
        resolve();
      };

      ws.onerror = () => {
        this.setStatus("disconnected");
        reject(new Error(`WebSocket connection failed: ${this.url}`));
      };

      ws.onclose = () => {
        this.ws = null;
        this.setStatus("disconnected");
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string) as BridgeMessage;
          this.messageHandlers.forEach((h) => h(msg));
        } catch {
          console.error("[WebBridge] Invalid message:", event.data);
        }
      };
    });
  }

  disconnect(): void {
    this.ws?.close();
    this.ws = null;
    this.setStatus("disconnected");
  }

  send(message: BridgeMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket not connected");
    }
    this.ws.send(JSON.stringify(message));
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandlers.add(handler);
  }
  offMessage(handler: MessageHandler): void {
    this.messageHandlers.delete(handler);
  }
  onStatusChange(handler: StatusHandler): void {
    this.statusHandlers.add(handler);
  }
  offStatusChange(handler: StatusHandler): void {
    this.statusHandlers.delete(handler);
  }

  private setStatus(status: TransportStatus): void {
    this._status = status;
    this.statusHandlers.forEach((h) => h(status));
  }
}
