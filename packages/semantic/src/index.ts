// @webbridge/semantic — entry point.
//
// PR 1: feature factory + JevClient + `jev_ping` diagnostic tool.
// PR 2: find_element / smart_click / smart_type (Layer 1 interaction).
// PR 3: rank_links / page_triage (Layer 1 discovery).
// Later PRs: flow runner + recipes (Layer 2).
// Plan: docs/semantic-feature-implementation-plan.md

import { JevClient } from "./jev/client.js";
import { createFindElementTool } from "./tools/find-element.js";
import { createSmartInteractTool } from "./tools/smart-interact.js";
import { createRankLinksTool } from "./tools/rank-links.js";
import { createPageTriageTool } from "./tools/page-triage.js";
import { FlowRunner } from "./flow/runner.js";
import { GoalRunner } from "./goal/loop.js";
import path from "node:path";
import type {
  CreateSemanticFeatureOptions,
  SemanticConfig,
  SemanticFeature,
  SemanticFeatureStatus,
  SideToolHandler,
} from "./types.js";
import { registerPrimitiveSideTools } from "./primitive/side-tools.js";

export function createSemanticFeature(
  options: CreateSemanticFeatureOptions
): SemanticFeature {
  const log = options.log ?? (() => {});
  const config: SemanticConfig = options.config;

  const jev =
    options.jev ??
    new JevClient({
      apiKey: config.jevApiKey || undefined,
      model: config.jevModel,
      baseUrl: config.jevBaseUrl,
      timeoutMs: config.jevTimeoutMs,
      log,
    });

  const sideTools = new Map<string, SideToolHandler>();
  registerPrimitiveSideTools(sideTools); // Zoma harness primitives (B2)

  // --- jev_ping -------------------------------------------------------------
  // Diagnostic: one real Jev round-trip. Read-only (no browser interaction),
  // so it keeps working while the daemon is paused and without an extension.
  sideTools.set("jev_ping", async () => {
    const result = await jev.ask(
      "WebBridge semantic layer connectivity check. The browser bridge asks Jev to confirm that fast structured decisions work end to end.",
      {
        alive: {
          type: "noul",
          instructions: "The state above is a meaningful, non-empty English sentence",
        },
      }
    );
    if (!result.ok) {
      return {
        ok: false,
        error: result.error,
        disabled: jev.disabled,
        hint: "Check TYPESAFE_API_KEY (or WEBBRIDGE_JEV_API_KEY) and WEBBRIDGE_JEV_* settings.",
      };
    }
    return {
      ok: true,
      model: result.model ?? jev.model,
      alive: result.answers.alive?.noul ?? null,
      tookMs: result.tookMs,
      cached: result.cached,
    };
  });

  // --- find_element / smart_click / smart_type (Layer 1, PR 2) -------------
  const findElement = createFindElementTool(jev, config);
  sideTools.set("find_element", findElement);
  sideTools.set("smart_click", createSmartInteractTool("click", findElement, config));
  sideTools.set("smart_type", createSmartInteractTool("type", findElement, config));

  // --- rank_links / page_triage (Layer 1 discovery, PR 3) -------------------
  sideTools.set("rank_links", createRankLinksTool(jev));
  sideTools.set("page_triage", createPageTriageTool(jev));

  // --- flow runner (Layer 2, PR 4) ------------------------------------------
  const flowsDir =
    process.env.WEBBRIDGE_FLOW_DIR ||
    path.join(process.cwd(), ".webbridge-data", "flows");
  const runner = new FlowRunner({ config, jev, flowsDir, log });

  sideTools.set("run_flow", async (args, call) => {
    if (typeof args.resume === "string") {
      if (typeof args.approve !== "undefined" && !Array.isArray(args.approve)) {
        throw new Error("run_flow: approve must be an array of gate ids");
      }
      return runner.resume(call, {
        runId: args.resume,
        approve: args.approve as string[] | undefined,
        params: args.params as Record<string, unknown> | undefined,
        stepDelayMs: typeof args.stepDelayMs === "number" ? args.stepDelayMs : undefined,
      });
    }
    if (typeof args.flow !== "string" || !args.flow) {
      throw new Error('run_flow: provide {flow} for a new run or {resume:"<runId>"} to continue');
    }
    return runner.start(call, {
      flow: args.flow,
      params: args.params as Record<string, unknown> | undefined,
      dryRun: args.dryRun === true,
      stepDelayMs: typeof args.stepDelayMs === "number" ? args.stepDelayMs : undefined,
    });
  });

  sideTools.set("flow_status", async (args) => {
    if (typeof args.runId === "string") {
      const run = runner.status(args.runId);
      if (!run) throw new Error(`flow_status: unknown run "${args.runId}"`);
      return run;
    }
    return { runs: runner.listRuns() };
  });

  sideTools.set("flow_wait", async (args) => {
    if (typeof args.runId !== "string") throw new Error("flow_wait: runId is required");
    const timeoutMs = typeof args.timeoutMs === "number" ? args.timeoutMs : 30_000;
    return runner.wait(args.runId, timeoutMs);
  });

  sideTools.set("flow_list", async () => ({
    flows: runner.listFlows(),
    runs: runner.listRuns(),
  }));

  sideTools.set("flow_stop", async (args) => {
    if (typeof args.runId !== "string") throw new Error("flow_stop: runId is required");
    return runner.stop(args.runId);
  });

  // --- goal loop (Layer 3: goal-driven, zero LLM turns per step) -------------
  const goalsDir = process.env.WEBBRIDGE_GOAL_DIR || path.join(flowsDir, "goals");
  const goalRunner = new GoalRunner({ config, jev, goalsDir, log });

  sideTools.set("run_goal", async (args, call) => {
    if (typeof args.resume === "string") {
      return goalRunner.resume(call, {
        runId: args.resume,
        stepDelayMs: typeof args.stepDelayMs === "number" ? args.stepDelayMs : undefined,
        hint: typeof args.hint === "string" ? args.hint : undefined,
      });
    }
    if (typeof args.goal !== "string" || !args.goal.trim()) {
      throw new Error('run_goal: provide {goal} for a new run or {resume:"<runId>"} to continue');
    }
    return goalRunner.start(call, {
      goal: args.goal,
      requestId: typeof args.requestId === 'string' ? args.requestId : undefined,
      safety: args.safety as import('./goal/safety.js').GoalSafety | undefined,
      budgetMs: typeof args.budgetMs === 'number' ? args.budgetMs : undefined,
      tabId: typeof args.tabId === "number" ? args.tabId : undefined,
      maxSteps: typeof args.maxSteps === "number" ? args.maxSteps : undefined,
      dryRun: args.dryRun === true,
      stepDelayMs: typeof args.stepDelayMs === "number" ? args.stepDelayMs : undefined,
    });
  });

  // « Analyse avant de faire » : briefing d'exécution écrit par le petit modèle
  // (objectif, requête, contraintes, étapes génériques, condition d'arrêt).
  sideTools.set("task_brief", async (args) => {
    const goal = String(args?.goal ?? "").trim();
    if (!goal) throw new Error("task_brief: {goal} is required");
    if (!config.textModelApiKey) throw new Error("task_brief: no text model configured (WEBBRIDGE_TEXT_MODEL_API_KEY)");
    const { createTextHelper, BRIEF_VALUE } = await import("./goal/text-helper.js");
    const brief = createTextHelper(
      { apiKey: config.textModelApiKey, baseUrl: config.textModelBaseUrl, model: config.textModelId, reasoning: config.textModelReasoning },
      undefined,
      BRIEF_VALUE
    );
    return brief({ goal, field: { label: "execution brief", role: "plan" }, page: {}, recent_actions: [] });
  });

  sideTools.set("goal_status", async (args) => {
    if (typeof args.runId === "string") {
      const run = goalRunner.status(args.runId);
      if (!run) throw new Error(`goal_status: unknown run "${args.runId}"`);
      return run;
    }
    return { runs: goalRunner.listRuns(), capabilities: goalRunner.capabilities() };
  });

  sideTools.set("goal_wait", async (args) => {
    if (typeof args.runId !== "string") throw new Error("goal_wait: runId is required");
    const timeoutMs = typeof args.timeoutMs === "number" ? args.timeoutMs : 30_000;
    return goalRunner.wait(args.runId, timeoutMs);
  });

  sideTools.set("goal_stop", async (args) => {
    if (typeof args.runId !== "string") throw new Error("goal_stop: runId is required");
    return goalRunner.stop(args.runId);
  });

  const status = (): SemanticFeatureStatus => {
    const last = jev.getLastCall();
    return {
      enabled: true,
      jev: jev.disabled ? "no_api_key" : last ? (last.ok ? "ok" : "error") : "untested",
      model: jev.model,
      tools: [...sideTools.keys()],
      last_call: last,
    };
  };

  return {
    sideTools,
    readOnlyToolNames: ["jev_ping", "flow_status", "flow_list", "flow_wait", "goal_status", "goal_wait"],
    status,
  };
}

export { JevClient } from "./jev/client.js";
export { LruCache, canonicalJson, stableHash } from "./jev/cache.js";
export type * from "./types.js";
