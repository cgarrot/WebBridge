import { loadConfig } from "./config/index.js";
import { ConnectionManager } from "./connection/manager.js";
import { ToolRouter } from "./router/tool-router.js";
import { startWebSocketServer } from "./server/ws-server.js";
import { startHttpServer } from "./server/http-server.js";
import { NativeHostTransport } from "./native-host/host.js";

async function main(): Promise<void> {
  const config = loadConfig();

  console.log(`[WebBridge Daemon] Starting in ${config.mode} mode`);

  const connectionManager = new ConnectionManager(config);
  const toolRouter = new ToolRouter(connectionManager, config);

  if (config.mode === "native-host") {
    const nativeTransport = new NativeHostTransport();
    connectionManager.addConnection(nativeTransport);
    nativeTransport.startReadLoop();
  } else {
    startWebSocketServer(config, connectionManager);
  }

  await startHttpServer(config, toolRouter, connectionManager);

  console.log("[WebBridge Daemon] Ready");
}

main().catch((err) => {
  console.error("[WebBridge Daemon] Fatal:", err);
  process.exit(1);
});
