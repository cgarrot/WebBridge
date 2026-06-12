import Fastify from "fastify";
import type { DaemonConfig } from "../config/index.js";
import type { ToolRouter } from "../router/tool-router.js";
import type { ConnectionManager } from "../connection/manager.js";
import { normalizeCommandBody, normalizeToolName } from "../compat/command-normalizer.js";

interface ToolCallBody {
  name: string;
  args?: Record<string, unknown>;
}

const DAEMON_VERSION = "0.1.0";
const SESSION_NAMED_TOOLS = new Set(["navigate", "new_tab", "claim_tab", "switch_tab"]);
const READ_ONLY_TOOLS = new Set([
  "list_tabs",
  "find_tab",
  "snapshot",
  "screenshot",
  "get_tab_info",
  "console_logs",
  "element_info",
]);

export async function startHttpServer(
  config: DaemonConfig,
  toolRouter: ToolRouter,
  connectionManager: ConnectionManager
) {
  const app = Fastify({ logger: config.logLevel === "debug" });
  let paused = false;
  let evaluateEnabled = false;

  const applyPolicy = (name: string): string | undefined => {
    const normalizedName = normalizeToolName(name);
    if (normalizedName === "evaluate" && !evaluateEnabled) {
      return "evaluate is disabled. Enable it with POST /config {\"evaluate_enabled\":true} before use.";
    }
    if (paused && !READ_ONLY_TOOLS.has(normalizedName)) {
      return "WebBridge browser control is paused. Read-only tools remain available.";
    }
    return undefined;
  };

  const buildHealth = () => {
    const connections = connectionManager.getConnectionInfo();
    const extensionVersion = connections.find((conn) => conn.extensionVersion)?.extensionVersion;
    const capabilities = [...new Set(connections.flatMap((conn) => conn.capabilities ?? []))];

    return {
      ok: true,
      status: "ok",
      running: true,
      extension_connected: connections.length > 0,
      connections: connections.length,
      daemon_version: DAEMON_VERSION,
      version: DAEMON_VERSION,
      extension_version: extensionVersion,
      capabilities,
      connection_details: connections,
      paused,
      evaluate_enabled: evaluateEnabled,
      mode: config.mode,
      ports: {
        http: config.httpPort,
        ws: config.wsPort,
      },
    };
  };

  app.get("/health", async () => buildHealth());
  app.get("/status", async () => buildHealth());
  app.get("/api/status", async () => buildHealth());

  app.post("/config", async (request) => {
    const body = request.body && typeof request.body === "object"
      ? (request.body as Record<string, unknown>)
      : {};
    if (typeof body.paused === "boolean") paused = body.paused;
    if (typeof body.evaluate_enabled === "boolean") evaluateEnabled = body.evaluate_enabled;
    if (typeof body.evaluateEnabled === "boolean") evaluateEnabled = body.evaluateEnabled;
    return { ok: true, paused, evaluate_enabled: evaluateEnabled };
  });

  app.post<{ Body: ToolCallBody }>("/api/tool", async (request, reply) => {
    const { name, args = {} } = request.body;

    if (!name) {
      return reply.status(400).send({ error: "Missing tool name" });
    }

    try {
      const policyError = applyPolicy(name);
      if (policyError) {
        return reply.status(403).send({ error: policyError });
      }

      const result = await toolRouter.callTool(name, args);
      if (result.error) {
        return reply.status(500).send({ error: result.error });
      }
      return { data: result.data };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(502).send({ error: msg });
    }
  });

  app.post("/command", async (request, reply) => {
    try {
      const command = normalizeCommandBody(request.body);

      const policyError = applyPolicy(command.name);
      if (policyError) {
        return reply.status(403).send({ ok: false, error: policyError });
      }

      if (command.sessionName && SESSION_NAMED_TOOLS.has(command.name)) {
        const sessionResult = await toolRouter.callTool("name_session", { name: command.sessionName });
        if (sessionResult.error) {
          return reply.status(500).send({ ok: false, error: sessionResult.error });
        }
      }

      const result = await toolRouter.callTool(command.name, command.args);
      if (result.error) {
        return reply.status(500).send({ ok: false, error: result.error });
      }
      return { ok: true, data: result.data };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ ok: false, error: msg });
    }
  });

  await app.listen({ host: "127.0.0.1", port: config.httpPort });
  console.log(`[HTTP] Listening on http://127.0.0.1:${config.httpPort}`);

  return app;
}
