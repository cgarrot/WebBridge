// Flow run persistence + evidence capture.
// Run state is written after EVERY step to <flowsDir>/<runId>/state.json so a
// crashed/killed daemon loses nothing and `run_flow {resume}` can continue.
// Screenshots are decoded from base64 and stored as files — never inlined.

import fs from "node:fs";
import path from "node:path";

export type FlowStatus =
  | "running"
  | "paused"
  | "paused_at_gate"
  | "completed"
  | "failed"
  | "stopped";

export interface StepLogEntry {
  step: number;
  verb: string;
  desc?: string;
  ok: boolean;
  note?: string;
  at: string;
  tookMs?: number;
}

export interface PauseInfo {
  step: { index: number; verb: string; desc?: string };
  reason: string;
  detail?: unknown;
  resumeHint?: string;
}

export interface RunState {
  runId: string;
  flowId: string;
  status: FlowStatus;
  dryRun: boolean;
  stepIndex: number;
  stepsTotal: number;
  stepsDone: number;
  params: Record<string, unknown>;
  vars: Record<string, string>;
  tabId?: number;
  approved: string[];
  stopRequested: boolean;
  startedAt: string;
  updatedAt: string;
  elapsedMs: number;
  lastPause?: PauseInfo;
  log: StepLogEntry[];
  evidence: string[];
  error?: string;
}

export function runDir(flowsDir: string, runId: string): string {
  return path.join(flowsDir, runId);
}

export function saveRunState(flowsDir: string, state: RunState): void {
  const dir = runDir(flowsDir, state.runId);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, "state.json.tmp");
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
  fs.renameSync(tmp, path.join(dir, "state.json"));
}

export function loadRunState(
  flowsDir: string,
  runId: string
): RunState | undefined {
  try {
    const file = path.join(runDir(flowsDir, runId), "state.json");
    if (!fs.existsSync(file)) return undefined;
    return JSON.parse(fs.readFileSync(file, "utf-8")) as RunState;
  } catch {
    return undefined;
  }
}

export function listRunIds(flowsDir: string): string[] {
  try {
    return fs
      .readdirSync(flowsDir)
      .filter((name) =>
        fs.existsSync(path.join(flowsDir, name, "state.json"))
      )
      .sort();
  } catch {
    return [];
  }
}

/** Decode a base64 screenshot and persist it; returns the relative evidence path. */
export function writeScreenshot(
  flowsDir: string,
  runId: string,
  stepIndex: number,
  label: string | undefined,
  base64: string
): string {
  const dir = runDir(flowsDir, runId);
  fs.mkdirSync(dir, { recursive: true });
  const name = `step-${String(stepIndex).padStart(3, "0")}${label ? `-${label}` : ""}.png`;
  fs.writeFileSync(path.join(dir, name), Buffer.from(base64, "base64"));
  return `${runId}/${name}`;
}

/** Load user recipes (*.json) from a directory; invalid files are skipped with a log line. */
export function loadRecipesFromDir(
  dir: string,
  log?: (line: string) => void
): Array<{ id: string; raw: unknown; source: string }> {
  const fsAny = fs;
  let files: string[] = [];
  try {
    files = fsAny.readdirSync(dir).filter((f: string) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out = [];
  for (const file of files) {
    try {
      const raw = JSON.parse(fsAny.readFileSync(path.join(dir, file), "utf-8"));
      const id = raw && typeof raw === "object" ? (raw as { id?: unknown }).id : undefined;
      if (typeof id === "string" && id.length > 0) {
        out.push({ id, raw, source: path.join(dir, file) });
      } else {
        log?.(`[flow] skipping ${file}: missing id`);
      }
    } catch (err) {
      log?.(`[flow] skipping ${file}: ${(err as Error).message}`);
    }
  }
  return out;
}
