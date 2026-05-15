import Fastify from "fastify";
import type { DaemonConfig } from "../config/index.js";
import type { ToolRouter } from "../router/tool-router.js";
import type { ConnectionManager } from "../connection/manager.js";

interface ToolCallBody {
  name: string;
  args?: Record<string, unknown>;
}

export async function startHttpServer(
  config: DaemonConfig,
  toolRouter: ToolRouter,
  connectionManager: ConnectionManager
) {
  const app = Fastify({ logger: config.logLevel === "debug" });

  app.get("/api/status", async () => ({
    status: "ok",
    connections: connectionManager.getConnectionCount(),
    version: "0.1.0",
  }));

  app.post<{ Body: ToolCallBody }>("/api/tool", async (request, reply) => {
    const { name, args = {} } = request.body;

    if (!name) {
      return reply.status(400).send({ error: "Missing tool name" });
    }

    try {
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

  await app.listen({ host: "127.0.0.1", port: config.httpPort });
  console.log(`[HTTP] Listening on http://127.0.0.1:${config.httpPort}`);

  return app;
}
