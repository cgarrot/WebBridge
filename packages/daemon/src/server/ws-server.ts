import { WebSocketServer } from "ws";
import type { DaemonConfig } from "../config/index.js";
import type { ConnectionManager } from "../connection/manager.js";
import { WebSocketDaemonTransport } from "../transport/websocket.js";

export function startWebSocketServer(
  config: DaemonConfig,
  connectionManager: ConnectionManager
): WebSocketServer {
  const wss = new WebSocketServer({
    host: config.wsHost,
    port: config.wsPort,
  });

  wss.on("listening", () => {
    console.log(`[WS] Listening on ws://${config.wsHost}:${config.wsPort}`);
  });

  wss.on("connection", (ws) => {
    const transport = new WebSocketDaemonTransport(ws);
    connectionManager.addConnection(transport);
  });

  wss.on("error", (err) => {
    console.error("[WS] Server error:", err.message);
  });

  return wss;
}
