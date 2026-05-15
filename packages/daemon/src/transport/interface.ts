import type { BridgeMessage } from "@webbridge/shared";

export type TransportMessageHandler = (message: BridgeMessage) => void;
export type TransportCloseHandler = () => void;

export interface IDaemonTransport {
  send(message: BridgeMessage): void;
  onMessage(handler: TransportMessageHandler): void;
  onClose(handler: TransportCloseHandler): void;
  close(): void;
}
