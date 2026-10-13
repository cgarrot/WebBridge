import { createToolCall, type BridgeMessage, type ToolResultMessage, TOOL_DEDUP_WINDOW_MS } from "@webbridge/shared";
import type { ConnectionManager } from "../connection/manager.js";
import type { DaemonConfig } from "../config/index.js";
import type { PolicyState } from "../runtime/policy.js";
import { randomUUID } from "crypto";

interface PendingCall {
  resolve: (result: ToolResultMessage["payload"]) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

type ToolPayload = ToolResultMessage["payload"];

/**
 * Daemon-side side-feature tool handler (semantic layer). Structurally
 * compatible with @webbridge/semantic's SideToolHandler — the daemon never
 * imports that package statically.
 *
 * `call` is policy-aware: nested tool invocations obey `paused` /
 * `evaluate_enabled` exactly like direct HTTP callers, then route through the
 * normal ToolRouter (dedup, timeout, extension dispatch). No CDP bypass.
 */
export type SideToolHandler = (
  args: Record<string, unknown>,
  call: (name: string, args?: Record<string, unknown>) => Promise<unknown>
) => Promise<unknown>;

/**
 * Tools whose repeated invocation within a short window is safe to collapse.
 * navigate reuses tabs (idempotent); new_tab always creates but is bounded by
 * the agent tab cap. Dedup prevents a rapid agent retry from spawning duplicate
 * work / duplicate tabs when the first call is still in flight or just finished.
 */
const DEDUP_TOOLS = new Set(["navigate", "new_tab"]);

/** Stable key so {a:1,b:2} and {b:2,a:1} collapse to the same dedup key. */
function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(obj[k])}`)}}`;
}

export class ToolRouter {
  private pending = new Map<string, PendingCall>();
  private inflight = new Map<string, Promise<ToolPayload>>();
  private completed = new Map<string, { result: ToolPayload; expiresAt: number }>();
  private sideTools = new Map<string, SideToolHandler>();

  constructor(
    private connectionManager: ConnectionManager,
    private config: DaemonConfig,
    private policy?: PolicyState
  ) {
    this.connectionManager.onMessage((msg) => {
      if (msg.type === "tool_result") {
        this.handleResult(msg);
      }
    });
  }

  /** Register a daemon-side side-feature tool (never dispatched to the extension). */
  registerSideTool(name: string, handler: SideToolHandler): void {
    this.sideTools.set(name, handler);
  }

  clearSideTools(): void {
    this.sideTools.clear();
  }

  sideToolNames(): string[] {
    return [...this.sideTools.keys()];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolPayload> {
    // Side-feature tools are handled entirely daemon-side. They run without an
    // extension connection when they don't touch the browser (e.g. jev_ping).
    const side = this.sideTools.get(name);
    if (side) {
      try {
        const data = await side(args, (n, a) => this.policyCall(n, a ?? {}));
        return { data };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    }

    const transport = this.connectionManager.getActiveTransport();
    if (!transport) {
      throw new Error("No extension connected");
    }

    // Idempotence / dedup for safe-to-collapse tools.
    const dedupKey = DEDUP_TOOLS.has(name) ? `${name}:${canonicalStringify(args)}` : null;
    if (dedupKey) {
      const inflight = this.inflight.get(dedupKey);
      if (inflight) {
        console.log(`[tool-router] dedup: reusing in-flight "${name}"`);
        return inflight;
      }
      const cached = this.completed.get(dedupKey);
      if (cached && cached.expiresAt > Date.now()) {
        console.log(`[tool-router] dedup: returning cached "${name}"`);
        return cached.result;
      }
    }

    const promise = this.dispatch(name, args);

    if (dedupKey) {
      this.inflight.set(dedupKey, promise);
      promise
        .then((result) => {
          this.inflight.delete(dedupKey);
          // Cache SUCCESSFUL results only: an error payload must never be
          // replayed to a retrying agent (it would look like a persistent
          // failure even after the transient cause is gone).
          if (result.error === undefined) {
            this.completed.set(dedupKey, { result, expiresAt: Date.now() + TOOL_DEDUP_WINDOW_MS });
            setTimeout(() => this.completed.delete(dedupKey), TOOL_DEDUP_WINDOW_MS + 500);
          }
        })
        .catch(() => {
          this.inflight.delete(dedupKey);
        });
    }

    return promise;
  }

  /**
   * Policy-aware nested call handed to side-feature tools. Applies the same
   * gates as direct HTTP callers, then routes through callTool (side tools can
   * compose other tools, including other side tools — bounded by design).
   */
  private async policyCall(name: string, args: Record<string, unknown>): Promise<unknown> {
    const policyError = this.policy?.check(name);
    if (policyError) throw new Error(policyError);
    const payload = await this.callTool(name, args);
    if (payload.error !== undefined) {
      throw new Error(payload.error);
    }
    return payload.data;
  }

  private dispatch(name: string, args: Record<string, unknown>): Promise<ToolPayload> {
    const transport = this.connectionManager.getActiveTransport();
    // Transport existence was checked by the caller; guard again for type safety.
    if (!transport) {
      return Promise.reject(new Error("No extension connected"));
    }

    const requestId = randomUUID();
    const message = createToolCall(requestId, name, args);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Tool call "${name}" timed out after ${this.config.toolCallTimeoutMs}ms`));
      }, this.config.toolCallTimeoutMs);

      this.pending.set(requestId, { resolve, reject, timer });
      transport.send(message);
    });
  }

  private handleResult(msg: ToolResultMessage): void {
    const pending = this.pending.get(msg.responseToRequestId);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pending.delete(msg.responseToRequestId);
    pending.resolve(msg.payload);
  }
}
