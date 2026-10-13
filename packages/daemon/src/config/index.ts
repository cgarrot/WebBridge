import {
  DEFAULT_WS_PORT,
  DEFAULT_WS_HOST,
  DEFAULT_HTTP_PORT,
  HEARTBEAT_INTERVAL_MS,
  TOOL_CALL_TIMEOUT_MS,
  DEFAULT_JEV_MODEL,
  DEFAULT_JEV_BASE_URL,
  DEFAULT_JEV_TIMEOUT_MS,
  DEFAULT_JEV_MIN_CONFIDENCE,
  DEFAULT_JEV_MAX_CANDIDATES,
} from "@webbridge/shared";

export interface DaemonConfig {
  wsHost: string;
  wsPort: number;
  httpPort: number;
  heartbeatIntervalMs: number;
  toolCallTimeoutMs: number;
  logLevel: "debug" | "info" | "warn" | "error";
  mode: "standalone" | "native-host";
  // --- Semantic side-feature (Jev / TypeSafe) — opt-in, additive -------------
  semanticEnabled: boolean;
  jevApiKey: string;
  jevModel: string;
  jevBaseUrl: string;
  jevTimeoutMs: number;
  jevMinConfidence: number;
  jevMaxCandidates: number;
  // --- Goal loop (`run_goal`) — only TYPE_TEXT needs a generative model ------
  /** OpenAI-compatible key for the TYPE_TEXT helper (optional). */
  textModelApiKey: string;
  textModelBaseUrl: string;
  textModelId: string;
  /** "none" disables provider-side reasoning (fastest). */
  textModelReasoning: string;
}

function envInt(key: string, fallback: number): number {
  const val = process.env[key];
  return val ? parseInt(val, 10) : fallback;
}

function envStr<T extends string>(key: string, fallback: T): T {
  return (process.env[key] as T) ?? fallback;
}

function envFloat(key: string, fallback: number): number {
  const val = process.env[key];
  const n = val ? parseFloat(val) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(): DaemonConfig {
  return {
    wsHost: envStr("WEBBRIDGE_WS_HOST", DEFAULT_WS_HOST),
    wsPort: envInt("WEBBRIDGE_WS_PORT", DEFAULT_WS_PORT),
    httpPort: envInt("WEBBRIDGE_HTTP_PORT", DEFAULT_HTTP_PORT),
    heartbeatIntervalMs: envInt("WEBBRIDGE_HEARTBEAT_MS", HEARTBEAT_INTERVAL_MS),
    toolCallTimeoutMs: envInt("WEBBRIDGE_TOOL_TIMEOUT_MS", TOOL_CALL_TIMEOUT_MS),
    logLevel: envStr("WEBBRIDGE_LOG_LEVEL", "info"),
    mode: process.env.WEBBRIDGE_NATIVE_HOST === "1" ? "native-host" : "standalone",
    // Semantic side-feature: disabled unless explicitly opted in AND an API
    // key is present. The runtime toggle (POST /config) can only enable it
    // when a key exists.
    semanticEnabled:
      process.env.WEBBRIDGE_SEMANTIC_ENABLED === "1" &&
      Boolean(process.env.WEBBRIDGE_JEV_API_KEY ?? process.env.TYPESAFE_API_KEY),
    jevApiKey: process.env.WEBBRIDGE_JEV_API_KEY ?? process.env.TYPESAFE_API_KEY ?? "",
    jevModel: envStr("WEBBRIDGE_JEV_MODEL", DEFAULT_JEV_MODEL),
    jevBaseUrl: envStr("WEBBRIDGE_JEV_BASE_URL", DEFAULT_JEV_BASE_URL),
    jevTimeoutMs: envInt("WEBBRIDGE_JEV_TIMEOUT_MS", DEFAULT_JEV_TIMEOUT_MS),
    jevMinConfidence: envFloat("WEBBRIDGE_JEV_MIN_CONFIDENCE", DEFAULT_JEV_MIN_CONFIDENCE),
    jevMaxCandidates: envInt("WEBBRIDGE_JEV_MAX_CANDIDATES", DEFAULT_JEV_MAX_CANDIDATES),
    // Goal loop (run_goal): TYPE_TEXT is the only operation that calls a
    // generative model. Same OpenAI-compatible env vars as jev-ultrafast.
    textModelApiKey:
      process.env.WEBBRIDGE_TEXT_MODEL_API_KEY ?? process.env.TEXT_MODEL_API_KEY ?? "",
    textModelBaseUrl: envStr(
      "WEBBRIDGE_TEXT_MODEL_BASE_URL",
      process.env.TEXT_MODEL_BASE_URL ?? "https://openrouter.ai/api/v1"
    ),
    textModelId: envStr(
      "WEBBRIDGE_TEXT_MODEL",
      process.env.TEXT_MODEL ?? "inception/mercury-2.5"
    ),
    textModelReasoning: envStr(
      "WEBBRIDGE_TEXT_MODEL_REASONING",
      process.env.TEXT_MODEL_REASONING ?? "none"
    ),
  };
}
