import {
  RECONNECT_DELAY_MS,
  MAX_RECONNECT_ATTEMPTS,
  type BridgeMessage,
} from "@webbridge/shared";
import type {
  ITransport,
  MessageHandler,
  StatusHandler,
  TransportStatus,
} from "./interface.js";
import { NativeTransport } from "./native.js";
import {
  WebSocketTransport,
  type WebSocketTransportOptions,
} from "./websocket.js";

export interface TransportManagerOptions {
  preferNative?: boolean;
  ws?: WebSocketTransportOptions;
}

export class TransportManager implements ITransport {
  private active: ITransport | null = null;
  private nativeTransport: NativeTransport;
  private wsTransport: WebSocketTransport;
  private messageHandlers = new Set<MessageHandler>();
  private statusHandlers = new Set<StatusHandler>();
  private _status: TransportStatus = "disconnected";
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private preferNative: boolean;

  constructor(options: TransportManagerOptions = {}) {
    this.preferNative = options.preferNative ?? true;
    this.nativeTransport = new NativeTransport();
    this.wsTransport = new WebSocketTransport(options.ws);
  }

  get status(): TransportStatus {
    return this._status;
  }

  async connect(): Promise<void> {
    if (this.preferNative) {
      try {
        await this.activateTransport(this.nativeTransport);
        return;
      } catch {
        console.warn("[WebBridge] Native Messaging unavailable, trying WebSocket");
      }
    }

    try {
      await this.activateTransport(this.wsTransport);
    } catch {
      this.setStatus("disconnected");
      throw new Error("All transport channels failed");
    }
  }

  disconnect(): void {
    this.cancelReconnect();
    this.active?.disconnect();
    this.active = null;
    this.setStatus("disconnected");
  }

  send(message: BridgeMessage): void {
    if (!this.active || this._status !== "connected") {
      throw new Error("No active transport");
    }
    this.active.send(message);
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

  private async activateTransport(transport: ITransport): Promise<void> {
    this.setStatus("connecting");
    await transport.connect();

    this.active = transport;
    this.reconnectAttempts = 0;

    transport.onMessage((msg) => {
      this.messageHandlers.forEach((h) => h(msg));
    });

    transport.onStatusChange((status) => {
      if (status === "disconnected" && this.active === transport) {
        this.scheduleReconnect();
      }
    });

    this.setStatus("connected");
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.error("[WebBridge] Max reconnect attempts reached");
      this.setStatus("disconnected");
      return;
    }

    this.setStatus("connecting");
    this.reconnectAttempts++;

    const delay = RECONNECT_DELAY_MS * Math.min(this.reconnectAttempts, 5);
    this.reconnectTimer = setTimeout(() => {
      this.connect().catch(() => {
        console.warn(`[WebBridge] Reconnect attempt ${this.reconnectAttempts} failed`);
      });
    }, delay);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private setStatus(status: TransportStatus): void {
    this._status = status;
    this.statusHandlers.forEach((h) => h(status));
  }
}
