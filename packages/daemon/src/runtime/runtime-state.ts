import fs from "node:fs";
import { DATA_DIR, LOG_FILE, PID_FILE, RUNTIME_FILE, ROOT_DIR } from "./paths.js";

export interface RuntimeState {
  pid: number;
  host: string;
  httpPort: number;
  wsPort: number;
  startedAt: string;
  rootDir: string;
  logFile: string;
}

export function writeRuntimeState(state: RuntimeState): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmpPath = `${RUNTIME_FILE}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf-8");
  fs.renameSync(tmpPath, RUNTIME_FILE);
  fs.writeFileSync(PID_FILE, `${state.pid}\n`, "utf-8");
}

export function readRuntimeState(): RuntimeState | null {
  try {
    const raw = fs.readFileSync(RUNTIME_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<RuntimeState>;
    if (
      typeof parsed.pid !== "number" ||
      typeof parsed.httpPort !== "number" ||
      typeof parsed.wsPort !== "number"
    ) {
      return null;
    }
    return {
      pid: parsed.pid,
      host: parsed.host ?? "127.0.0.1",
      httpPort: parsed.httpPort,
      wsPort: parsed.wsPort,
      startedAt: parsed.startedAt ?? "",
      rootDir: parsed.rootDir ?? ROOT_DIR,
      logFile: parsed.logFile ?? LOG_FILE,
    };
  } catch {
    return null;
  }
}

export function clearRuntimeState(pid?: number): void {
  const state = readRuntimeState();
  if (pid !== undefined && state && state.pid !== pid) return;
  for (const file of [RUNTIME_FILE, PID_FILE]) {
    try {
      fs.unlinkSync(file);
    } catch {}
  }
}

export function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
