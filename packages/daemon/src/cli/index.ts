import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  DATA_DIR,
  LOG_FILE,
  PID_FILE,
  ROOT_DIR,
  RUNTIME_FILE,
} from "../runtime/paths.js";
import { clearRuntimeState, isPidRunning, readRuntimeState } from "../runtime/runtime-state.js";
import { DEFAULT_HTTP_PORT, DEFAULT_WS_PORT } from "@webbridge/shared";

interface PortOptions {
  httpPort?: number;
  wsPort?: number;
}

const args = process.argv.slice(2);
const command = args[0] ?? "serve";

async function main(): Promise<void> {
  switch (command) {
    case "serve":
      await import("../index.js");
      break;
    case "start":
      await startCommand(parsePortOptions(args));
      break;
    case "stop":
      await stopCommand();
      break;
    case "restart":
      await stopCommand(false);
      await startCommand(parsePortOptions(args));
      break;
    case "status":
      await statusCommand();
      break;
    case "logs":
      await logsCommand({ follow: args.includes("--follow") || args.includes("-f") });
      break;
    case "doctor":
      await doctorCommand();
      break;
    case "help":
    case "--help":
    case "-h":
      printUsage();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
  }
}

async function startCommand(options: PortOptions = {}): Promise<void> {
  const existing = readRuntimeState();
  if (existing && isPidRunning(existing.pid)) {
    console.log(`WebBridge daemon is already running (PID ${existing.pid})`);
    console.log(`HTTP: http://${existing.host}:${existing.httpPort}`);
    console.log(`WS: ws://${existing.host}:${existing.wsPort}`);
    return;
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  clearRuntimeState();

  const daemonEntry = path.join(ROOT_DIR, "packages/daemon/dist/index.js");
  if (!fs.existsSync(daemonEntry)) {
    throw new Error(`Daemon build not found: ${daemonEntry}. Run pnpm build first.`);
  }

  const out = fs.openSync(LOG_FILE, "a");
  const httpPort = options.httpPort ?? parseEnvPort("WEBBRIDGE_HTTP_PORT") ?? DEFAULT_HTTP_PORT;
  const wsPort = options.wsPort ?? parseEnvPort("WEBBRIDGE_WS_PORT") ?? DEFAULT_WS_PORT;
  const child = spawn(process.execPath, [daemonEntry], {
    cwd: ROOT_DIR,
    detached: true,
    env: {
      ...process.env,
      WEBBRIDGE_ROOT: ROOT_DIR,
      WEBBRIDGE_HTTP_PORT: String(httpPort),
      WEBBRIDGE_WS_PORT: String(wsPort),
    },
    stdio: ["ignore", out, out],
  });

  child.unref();
  fs.writeFileSync(PID_FILE, `${child.pid ?? ""}\n`, "utf-8");
  await waitForRuntime();
  await statusCommand();
}

async function stopCommand(print = true): Promise<void> {
  const state = readRuntimeState();
  let stopped = false;
  if (state && isPidRunning(state.pid)) {
    process.kill(state.pid, "SIGTERM");
    stopped = true;
    await sleep(500);
  }
  clearRuntimeState(state?.pid);
  if (print) console.log(stopped ? "WebBridge daemon stopped" : "WebBridge daemon was not running");
}

async function statusCommand(): Promise<void> {
  const state = readRuntimeState();
  if (!state) {
    console.log("Daemon: Not running (no runtime.json)");
    return;
  }

  const running = isPidRunning(state.pid);
  console.log(`Daemon: ${running ? `Running (PID ${state.pid})` : `Stale runtime state (PID ${state.pid})`}`);
  console.log(`HTTP: http://${state.host}:${state.httpPort}`);
  console.log(`WS: ws://${state.host}:${state.wsPort}`);
  console.log(`Started at: ${state.startedAt || "unknown"}`);
  console.log(`Log file: ${state.logFile}`);

  if (running) {
    try {
      const health = await fetchJson(`http://${state.host}:${state.httpPort}/health`);
      const connected = health.extension_connected ? `Connected (${health.connections ?? 0})` : "Not connected";
      console.log(`Extension: ${connected}`);
    } catch {
      console.log("Extension: Cannot query health endpoint");
    }
  }
}

async function logsCommand(options: { follow?: boolean }): Promise<void> {
  if (!fs.existsSync(LOG_FILE)) {
    console.log(`No log file found: ${LOG_FILE}`);
    return;
  }
  const tailArgs = options.follow ? ["-f", LOG_FILE] : ["-n", "120", LOG_FILE];
  const child = spawn("tail", tailArgs, { stdio: "inherit" });
  await new Promise<void>((resolve, reject) => {
    child.on("exit", () => resolve());
    child.on("error", reject);
  });
}

async function doctorCommand(): Promise<void> {
  const results: Array<{ label: string; ok: boolean; detail?: string; fix?: string }> = [];
  const nodeMajor = Number(process.version.slice(1).split(".")[0]);
  results.push({ label: "Node.js version", ok: nodeMajor >= 18, detail: process.version, fix: "Install Node.js 18+" });
  results.push({ label: "Daemon build", ok: fs.existsSync(path.join(ROOT_DIR, "packages/daemon/dist/index.js")), fix: "Run pnpm build" });
  results.push({ label: "Extension build", ok: fs.existsSync(path.join(ROOT_DIR, "packages/extension/dist/manifest.json")), fix: "Run pnpm build:extension" });
  results.push({ label: "Runtime state", ok: fs.existsSync(RUNTIME_FILE), detail: RUNTIME_FILE });

  const state = readRuntimeState();
  if (state && isPidRunning(state.pid)) {
    try {
      const health = await fetchJson(`http://${state.host}:${state.httpPort}/health`);
      results.push({ label: "Local API reachable", ok: true, detail: `:${state.httpPort}` });
      results.push({ label: "Extension connected", ok: health.extension_connected === true, detail: `${health.connections ?? 0} connection(s)`, fix: "Load or reload the WebBridge Chrome extension" });
      results.push({ label: "Registered tools", ok: Array.isArray(health.capabilities) && health.capabilities.length > 0, detail: Array.isArray(health.capabilities) ? `${health.capabilities.length} capabilities` : undefined });
    } catch {
      results.push({ label: "Local API reachable", ok: false, fix: "Run webbridge restart" });
    }
  } else {
    results.push({ label: "Daemon running", ok: false, fix: "Run webbridge start" });
  }

  console.log("\nWebBridge Doctor\n");
  let failed = false;
  for (const result of results) {
    console.log(`  ${result.ok ? "✅" : "❌"} ${result.label}${result.detail ? ` (${result.detail})` : ""}`);
    if (!result.ok) {
      failed = true;
      if (result.fix) console.log(`     💡 ${result.fix}`);
    }
  }
  console.log(failed ? "\nSome checks failed.\n" : "\nWebBridge is ready.\n");
}

function parsePortOptions(values: string[]): PortOptions {
  return {
    httpPort: parseFlagPort(values, "--http-port") ?? parseFlagPort(values, "--api-port"),
    wsPort: parseFlagPort(values, "--ws-port") ?? parseFlagPort(values, "--port"),
  };
}

function parseFlagPort(values: string[], flag: string): number | undefined {
  const index = values.indexOf(flag);
  if (index === -1) return undefined;
  return parsePort(values[index + 1]);
}

function parseEnvPort(key: string): number | undefined {
  return parsePort(process.env[key]);
}

function parsePort(value: string | undefined): number | undefined {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 ? port : undefined;
}

async function waitForRuntime(): Promise<void> {
  for (let i = 0; i < 40; i++) {
    const state = readRuntimeState();
    if (state && isPidRunning(state.pid)) return;
    await sleep(250);
  }
  throw new Error(`WebBridge daemon did not write runtime state. Check log: ${LOG_FILE}`);
}

async function fetchJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as Record<string, unknown>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printUsage(): void {
  console.log(`Usage: webbridge <command>\n\nCommands:\n  serve      Run the daemon in the foreground\n  start      Start the daemon in the background\n  stop       Stop the background daemon\n  restart    Restart the background daemon\n  status     Show daemon and extension status\n  logs       Show daemon logs (-f/--follow to tail)\n  doctor     Run local diagnostics\n\nOptions:\n  --http-port <port>  HTTP API port for start/restart\n  --ws-port <port>    WebSocket port for start/restart`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
