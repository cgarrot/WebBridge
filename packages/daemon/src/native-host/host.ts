import type { BridgeMessage } from "@webbridge/shared";
import { readMessage, writeMessage } from "./stdio.js";
import type {
  IDaemonTransport,
  TransportMessageHandler,
  TransportCloseHandler,
} from "../transport/interface.js";

export class NativeHostTransport implements IDaemonTransport {
  private messageHandlers = new Set<TransportMessageHandler>();
  private closeHandlers = new Set<TransportCloseHandler>();
  private running = false;

  send(message: BridgeMessage): void {
    writeMessage(process.stdout, message);
  }

  onMessage(handler: TransportMessageHandler): void {
    this.messageHandlers.add(handler);
  }

  onClose(handler: TransportCloseHandler): void {
    this.closeHandlers.add(handler);
  }

  close(): void {
    this.running = false;
    this.closeHandlers.forEach((h) => h());
  }

  async startReadLoop(): Promise<void> {
    this.running = true;
    process.stdin.resume();

    while (this.running) {
      try {
        const msg = (await readMessage(process.stdin)) as BridgeMessage;
        this.messageHandlers.forEach((h) => h(msg));
      } catch (err) {
        if (this.running) {
          console.error("[NativeHost] Read error:", err);
          this.close();
        }
        break;
      }
    }
  }
}
