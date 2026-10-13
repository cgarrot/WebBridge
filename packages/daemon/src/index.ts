import { loadConfig } from "./config/index.js";
import { ConnectionManager } from "./connection/manager.js";
import { ToolRouter } from "./router/tool-router.js";
import { startWebSocketServer } from "./server/ws-server.js";
import { startHttpServer } from "./server/http-server.js";
import { NativeHostTransport } from "./native-host/host.js";
import { PolicyState } from "./runtime/policy.js";
import { LOG_FILE } from "./runtime/paths.js";
import { writeRuntimeState } from "./runtime/runtime-state.js";

async function main(): Promise<void> {
  const config = loadConfig();

  console.log(`[WebBridge Daemon] Starting in ${config.mode} mode`);

  const policy = new PolicyState();
  const connectionManager = new ConnectionManager(config);
  const toolRouter = new ToolRouter(connectionManager, config, policy);

  // --- Local primitives (ALWAYS registered, no API key) ---------------------
  // primitive_* are local daemon tools (observe/act/prove, zero cloud).
  // Conditioning them on a cloud API key was a bug (H02 post-restart outage).
  // Only genuine cloud calls (Jev/text-model) stay behind the flag+key below.
  {
    const { registerPrimitiveSideTools } = await import("@webbridge/semantic");
    const prim = new Map<string, (args: Record<string, unknown>,
      call: (name: string, args?: Record<string, unknown>) => Promise<unknown>) => Promise<unknown>>();
    registerPrimitiveSideTools(prim as never);
    for (const [name, handler] of prim)
      toolRouter.registerSideTool(name, handler as never);
    console.log(`[daemon] local primitives registered (${prim.size}, no key required)`);
  }

  // --- Optional semantic side-feature (Jev / TypeSafe) ----------------------
  // Side-car design: ALL logic lives in @webbridge/semantic, discovered via
  // dynamic import and enabled only when opted in
  // (WEBBRIDGE_SEMANTIC_ENABLED=1 + API key). Runtime toggle:
  // POST /config {"semantic_enabled":bool} — disabling clears the side tools.
  let semanticStatus: (() => Record<string, unknown> | undefined) | undefined;
  const enableSemantic = async (): Promise<void> => {
    if (semanticStatus) return; // already enabled
    const { createSemanticFeature } = await import("@webbridge/semantic");
    const feature = createSemanticFeature({
      config: {
        jevApiKey: config.jevApiKey,
        jevModel: config.jevModel,
        jevBaseUrl: config.jevBaseUrl,
        jevTimeoutMs: config.jevTimeoutMs,
        jevMinConfidence: config.jevMinConfidence,
        jevMaxCandidates: config.jevMaxCandidates,
        textModelApiKey: config.textModelApiKey,
        textModelBaseUrl: config.textModelBaseUrl,
        textModelId: config.textModelId,
        textModelReasoning: config.textModelReasoning,
      },
      log: (line) => console.log(line),
    });
    for (const [name, handler] of feature.sideTools) {
      toolRouter.registerSideTool(name, handler);
    }
    policy.setReadOnlySideTools(feature.readOnlyToolNames);
    semanticStatus = () => feature.status() as unknown as Record<string, unknown>;
    console.log(`[semantic] enabled (${[...feature.sideTools.keys()].join(", ")})`);
  };
  const disableSemantic = (): void => {
    toolRouter.clearSideTools();
    policy.setReadOnlySideTools([]);
    semanticStatus = undefined;
    console.log("[semantic] disabled");
  };
  if (config.semanticEnabled) {
    await enableSemantic();
  } else {
    console.log("[semantic] disabled (set WEBBRIDGE_SEMANTIC_ENABLED=1 + TYPESAFE_API_KEY to enable)");
  }

  if (config.mode === "native-host") {
    const nativeTransport = new NativeHostTransport();
    connectionManager.addConnection(nativeTransport);
    nativeTransport.startReadLoop();
  } else {
    startWebSocketServer(config, connectionManager);
  }

  await startHttpServer(config, toolRouter, connectionManager, {
    policy,
    onSemanticToggle: async (enabled) => {
      if (enabled) await enableSemantic();
      else disableSemantic();
    },
    semanticStatus: () => semanticStatus?.(),
  });

  writeRuntimeState({
    pid: process.pid,
    host: config.wsHost,
    httpPort: config.httpPort,
    wsPort: config.wsPort,
    startedAt: new Date().toISOString(),
    rootDir: process.cwd(),
    logFile: LOG_FILE,
  });

  console.log("[WebBridge Daemon] Ready");
}

main().catch((err) => {
  console.error("[WebBridge Daemon] Fatal:", err);
  process.exit(1);
});
