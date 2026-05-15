import { NATIVE_HOST_NAME, type BridgeMessage } from "@webbridge/shared";
import type {
  ITransport,
  MessageHandler,
  StatusHandler,
  TransportStatus,
} from "./interface.js";

export class NativeTransport implements ITransport {
  private port: chrome.runtime.Port | null = null;
  private messageHandlers = new Set<MessageHandler>();
  private statusHandlers = new Set<StatusHandler>();
  private _status: TransportStatus = "disconnected";

  get status(): TransportStatus {
    return this._status;
  }

  async connect(): Promise<void> {
    if (this._status === "connected") return;

    this.setStatus("connecting");
    try {
      this.port = chrome.runtime.connectNative(NATIVE_HOST_NAME);

      this.port.onMessage.addListener((msg: unknown) => {
        this.messageHandlers.forEach((h) => h(msg as BridgeMessage));
      });

      this.port.onDisconnect.addListener(() => {
        this.port = null;
        this.setStatus("disconnected");
      });

      this.setStatus("connected");
    } catch {
      this.setStatus("disconnected");
      throw new Error("Failed to connect via Native Messaging");
    }
  }

  disconnect(): void {
    this.port?.disconnect();
    this.port = null;
    this.setStatus("disconnected");
  }

  send(message: BridgeMessage): void {
    if (!this.port) throw new Error("Native port not connected");
    this.port.postMessage(message);
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
