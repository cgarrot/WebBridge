import type { BridgeMessage } from "@webbridge/shared";

export type TransportStatus = "disconnected" | "connecting" | "connected";

export type MessageHandler = (message: BridgeMessage) => void;
export type StatusHandler = (status: TransportStatus) => void;

export interface ITransport {
  readonly status: TransportStatus;

  connect(): Promise<void>;
  disconnect(): void;
  send(message: BridgeMessage): void;

  onMessage(handler: MessageHandler): void;
  offMessage(handler: MessageHandler): void;
  onStatusChange(handler: StatusHandler): void;
  offStatusChange(handler: StatusHandler): void;
}
