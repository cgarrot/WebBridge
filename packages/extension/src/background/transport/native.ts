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

  connect(): Promise<void> {
    if (this._status === "connected") return Promise.resolve();

    this.setStatus("connecting");

    return new Promise<void>((resolve, reject) => {
      let settled = false;

      try {
        this.port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
      } catch {
        this.setStatus("disconnected");
        reject(new Error("Failed to call connectNative"));
        return;
      }

      this.port.onDisconnect.addListener(() => {
        const error = chrome.runtime.lastError?.message;
        this.port = null;
        this.setStatus("disconnected");

        if (!settled) {
          settled = true;
          reject(new Error(error ?? "Native messaging host disconnected immediately"));
        }
      });

      this.port.onMessage.addListener((msg: unknown) => {
        if (!settled) {
          settled = true;
          this.setStatus("connected");
          resolve();
        }
        this.messageHandlers.forEach((h) => h(msg as BridgeMessage));
      });

      // If onDisconnect hasn't fired within 500ms, assume the host is alive
      // (it connected but hasn't sent a message yet — that's fine)
      setTimeout(() => {
        if (!settled && this.port) {
          settled = true;
          this.setStatus("connected");
          resolve();
        }
      }, 500);
    });
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
