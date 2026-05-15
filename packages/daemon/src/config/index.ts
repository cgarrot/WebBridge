import {
  DEFAULT_WS_PORT,
  DEFAULT_WS_HOST,
  DEFAULT_HTTP_PORT,
  HEARTBEAT_INTERVAL_MS,
  TOOL_CALL_TIMEOUT_MS,
} from "@webbridge/shared";

export interface DaemonConfig {
  wsHost: string;
  wsPort: number;
  httpPort: number;
  heartbeatIntervalMs: number;
  toolCallTimeoutMs: number;
  logLevel: "debug" | "info" | "warn" | "error";
  mode: "standalone" | "native-host";
}

function envInt(key: string, fallback: number): number {
  const val = process.env[key];
  return val ? parseInt(val, 10) : fallback;
}

function envStr<T extends string>(key: string, fallback: T): T {
  return (process.env[key] as T) ?? fallback;
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
  };
}
