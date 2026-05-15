import type { BridgeMessage } from "@webbridge/shared";
import type { IDaemonTransport, TransportMessageHandler } from "../transport/interface.js";
import type { DaemonConfig } from "../config/index.js";

interface ExtensionConnection {
  id: string;
  transport: IDaemonTransport;
  extensionVersion?: string;
  connectedAt: number;
}

export class ConnectionManager {
  private connections = new Map<string, ExtensionConnection>();
  private messageHandlers = new Set<TransportMessageHandler>();
  private heartbeatTimers = new Map<string, ReturnType<typeof setInterval>>();
  private nextId = 1;

  constructor(private config: DaemonConfig) {}

  addConnection(transport: IDaemonTransport): string {
    const id = `ext-${this.nextId++}`;
    const conn: ExtensionConnection = {
      id,
      transport,
      connectedAt: Date.now(),
    };

    this.connections.set(id, conn);
    console.log(`[ConnectionManager] New connection: ${id}`);

    transport.onMessage((msg) => {
      if (msg.type === "hello") {
        conn.extensionVersion = msg.payload.extensionVersion;
        transport.send({
          type: "hello_ack",
          payload: { daemonVersion: "0.1.0" },
        });
        console.log(`[ConnectionManager] ${id} hello — extension v${conn.extensionVersion}`);
      }
      this.messageHandlers.forEach((h) => h(msg));
    });

    transport.onClose(() => {
      this.removeConnection(id);
    });

    this.startHeartbeat(id);
    return id;
  }

  removeConnection(id: string): void {
    const conn = this.connections.get(id);
    if (!conn) return;

    this.stopHeartbeat(id);
    conn.transport.close();
    this.connections.delete(id);
    console.log(`[ConnectionManager] Disconnected: ${id}`);
  }

  getActiveTransport(): IDaemonTransport | undefined {
    const first = this.connections.values().next();
    return first.done ? undefined : first.value.transport;
  }

  onMessage(handler: TransportMessageHandler): void {
    this.messageHandlers.add(handler);
  }

  broadcast(message: BridgeMessage): void {
    for (const conn of this.connections.values()) {
      conn.transport.send(message);
    }
  }

  getConnectionCount(): number {
    return this.connections.size;
  }

  private startHeartbeat(id: string): void {
    const timer = setInterval(() => {
      const conn = this.connections.get(id);
      if (!conn) {
        this.stopHeartbeat(id);
        return;
      }
      conn.transport.send({ type: "ping", timestamp: Date.now() });
    }, this.config.heartbeatIntervalMs);

    this.heartbeatTimers.set(id, timer);
  }

  private stopHeartbeat(id: string): void {
    const timer = this.heartbeatTimers.get(id);
    if (timer) {
      clearInterval(timer);
      this.heartbeatTimers.delete(id);
    }
  }
}
