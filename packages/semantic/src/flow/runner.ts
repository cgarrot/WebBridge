// FlowRunner — daemon-side step sequencer (Layer 2 core).
//
// Async job model: `run_flow` returns a runId immediately; execution loops in
// the background, persisting state after EVERY step (<flowsDir>/<runId>/state.json)
// so a killed daemon loses nothing. Pause/resume is the "LLM takes back
// control" contract: any verify failure, low confidence, gate, or unexpected
// state pauses the run and returns a compact, actionable snapshot.

import { randomUUID } from "node:crypto";
import type { JevClient } from "../jev/client.js";
import type { SemanticConfig, SideToolCall } from "../types.js";
import { validateRecipe, type FlowRecipe, VERBS_REQUIRING_EVALUATE } from "./dsl.js";
import {
  listRunIds,
  loadRecipesFromDir,
  loadRunState,
  saveRunState,
  type RunState,
} from "./evidence.js";
import { BUILT_IN_RECIPES } from "./recipes.js";
import { execVerb, VerbPause, type VerbContext } from "./verbs.js";

const MAX_WAIT_MS = 120_000;

export interface RunnerDeps {
  config: SemanticConfig;
  jev: JevClient;
  flowsDir: string;
  log?: (line: string) => void;
}

export class FlowRunner {
  private runs = new Map<string, RunState>();
  private waiters = new Map<string, Array<() => void>>();
  private userRecipes = new Map<string, FlowRecipe>();

  constructor(private deps: RunnerDeps) {
    this.reloadUserRecipes();
  }

  reloadUserRecipes(): void {
    this.userRecipes.clear();
    for (const { raw } of loadRecipesFromDir(this.deps.flowsDir, this.deps.log)) {
      const validated = validateRecipe(raw);
      if (validated.ok) {
        this.userRecipes.set(validated.recipe.id, validated.recipe);
      } else {
        this.deps.log?.(`[flow] invalid recipe "${(raw as { id?: string }).id ?? "?"}": ${validated.errors.join("; ")}`);
      }
    }
  }

  listFlows(): Array<{ id: string; title?: string; site?: string; steps: number; source: string }> {
    const out = [];
    for (const recipe of BUILT_IN_RECIPES) {
      out.push({ id: recipe.id, title: recipe.title, site: recipe.site, steps: recipe.steps.length, source: "built-in" });
    }
    for (const recipe of this.userRecipes.values()) {
      out.push({ id: recipe.id, title: recipe.title, site: recipe.site, steps: recipe.steps.length, source: "user" });
    }
    return out;
  }

  getRecipe(id: string): FlowRecipe | undefined {
    return this.userRecipes.get(id) ?? BUILT_IN_RECIPES.find((r) => r.id === id);
  }

  status(runId: string): RunState | undefined {
    return this.runs.get(runId) ?? loadRunState(this.deps.flowsDir, runId);
  }

  listRuns(limit = 20): Array<Pick<RunState, "runId" | "flowId" | "status" | "updatedAt" | "stepsDone" | "stepsTotal">> {
    const ids = new Set([...listRunIds(this.deps.flowsDir), ...this.runs.keys()]);
    return [...ids]
      .map((id) => this.status(id))
      .filter((s): s is RunState => !!s)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .slice(0, limit)
      .map((s) => ({
        runId: s.runId, flowId: s.flowId, status: s.status,
        updatedAt: s.updatedAt, stepsDone: s.stepsDone, stepsTotal: s.stepsTotal,
      }));
  }

  /** Fire-and-forget start. Returns the fresh run snapshot. */
  async start(
    call: SideToolCall,
    input: { flow: string; params?: Record<string, unknown>; dryRun?: boolean; stepDelayMs?: number }
  ): Promise<RunState> {
    const recipe = this.getRecipe(input.flow);
    if (!recipe) {
      throw new Error(`run_flow: unknown flow "${input.flow}" (see flow_list)`);
    }
    // Fail fast when the recipe needs evaluate but it is policy-disabled.
    if (recipe.steps.some((s) => VERBS_REQUIRING_EVALUATE.has(s.do))) {
      try {
        await call("evaluate", { expression: "1" });
      } catch (err) {
        throw new Error(
          `run_flow: recipe "${recipe.id}" uses evaluate-based verbs but evaluate is disabled or unreachable: ${(err as Error).message}`
        );
      }
    }

    const runId = `r_${randomUUID().slice(0, 12)}`;
    const now = new Date().toISOString();
    const run: RunState = {
      runId,
      flowId: recipe.id,
      status: "running",
      dryRun: !!input.dryRun,
      stepIndex: 0,
      stepsTotal: recipe.steps.length,
      stepsDone: 0,
      params: input.params ?? {},
      vars: {},
      approved: [],
      stopRequested: false,
      startedAt: now,
      updatedAt: now,
      elapsedMs: 0,
      log: [],
      evidence: [],
    };
    this.runs.set(runId, run);
    saveRunState(this.deps.flowsDir, run);
    this.deps.log?.(`[flow] ${runId} started (${recipe.id}${run.dryRun ? ", dry-run" : ""})`);
    void this.loop(run, recipe, call, input.stepDelayMs ?? 0).catch((err) => {
      // Safety net: loop() handles its own errors; this guards programming bugs.
      run.status = "failed";
      run.error = String(err);
      saveRunState(this.deps.flowsDir, run);
      this.notifyWaiters(runId);
    });
    return { ...run };
  }

  /** Resume a paused/paused_at_gate run. */
  async resume(
    call: SideToolCall,
    input: { runId: string; approve?: string[]; params?: Record<string, unknown>; stepDelayMs?: number }
  ): Promise<RunState> {
    const run = this.status(input.runId);
    if (!run) throw new Error(`run_flow: unknown run "${input.runId}"`);
    if (run.status !== "paused" && run.status !== "paused_at_gate") {
      throw new Error(`run_flow: run "${input.runId}" is ${run.status} (only paused runs can resume)`);
    }
    const recipe = this.getRecipe(run.flowId);
    if (!recipe) throw new Error(`run_flow: recipe "${run.flowId}" no longer available`);

    if (run.status === "paused_at_gate" && input.approve?.length) {
      for (const gate of input.approve) run.approved.push(gate);
      this.deps.log?.(`[flow] ${run.runId} gates approved: ${input.approve.join(", ")}`);
    }
    if (input.params) {
      run.params = { ...run.params, ...input.params };
    }
    this.runs.set(run.runId, run);
    saveRunState(this.deps.flowsDir, run);

    // A gate that is now approved must be stepped past by re-executing it.
    const step = recipe.steps[run.stepIndex];
    const atApprovedGate =
      run.status === "paused_at_gate" && step?.do === "gate" &&
      run.approved.includes(step.id as string) &&
      !(Array.isArray(step.requiresParams)
        ? (step.requiresParams as string[]).some((p) => run.params?.[p] !== true)
        : false);
    if (atApprovedGate) {
      run.stepIndex += 1;
      run.stepsDone += 1;
      run.log.push({
        step: run.stepIndex - 1, verb: "gate", desc: step.desc,
        ok: true, note: `gate "${step.id}" approved`, at: new Date().toISOString(),
      });
    }

    run.status = "running";
    run.lastPause = undefined;
    saveRunState(this.deps.flowsDir, run);
    this.deps.log?.(`[flow] ${run.runId} resumed at step ${run.stepIndex}`);
    void this.loop(run, recipe, call, input.stepDelayMs ?? 0).catch((err) => {
      run.status = "failed";
      run.error = String(err);
      saveRunState(this.deps.flowsDir, run);
      this.notifyWaiters(run.runId);
    });
    return { ...run };
  }

  stop(runId: string): RunState {
    const run = this.status(runId);
    if (!run) throw new Error(`flow_stop: unknown run "${runId}"`);
    if (run.status === "running") {
      run.stopRequested = true;
      saveRunState(this.deps.flowsDir, run);
      return run;
    }
    return run;
  }

  /** Block until the run is terminal/paused (or timeout). Returns the snapshot. */
  async wait(runId: string, timeoutMs = 30_000): Promise<RunState | undefined> {
    const bounded = Math.min(Math.max(timeoutMs, 100), MAX_WAIT_MS);
    const deadline = Date.now() + bounded;
    while (Date.now() < deadline) {
      const run = this.status(runId);
      if (!run || run.status !== "running") return run;
      await new Promise<void>((resolve) => {
        const entry = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(entry, 250);
        (this.waiters.get(runId) ?? this.waiters.set(runId, []).get(runId)!).push(entry);
      });
    }
    return this.status(runId);
  }

  private notifyWaiters(runId: string): void {
    for (const entry of this.waiters.get(runId) ?? []) entry();
    this.waiters.delete(runId);
  }

  private async loop(
    run: RunState,
    recipe: FlowRecipe,
    call: SideToolCall,
    stepDelayMs: number
  ): Promise<void> {
    const startedClock = Date.now() - run.elapsedMs;
    while (run.stepIndex < recipe.steps.length) {
      if (run.stopRequested) {
        run.status = "stopped";
        run.updatedAt = new Date().toISOString();
        run.elapsedMs = Date.now() - startedClock;
        saveRunState(this.deps.flowsDir, run);
        this.notifyWaiters(run.runId);
        this.deps.log?.(`[flow] ${run.runId} stopped at step ${run.stepIndex}`);
        return;
      }

      const step = recipe.steps[run.stepIndex];
      const stepStart = Date.now();
      const ctx: VerbContext = {
        call, run, recipe,
        config: this.deps.config,
        jev: this.deps.jev,
        flowsDir: this.deps.flowsDir,
        dryRun: run.dryRun,
      };

      try {
        const outcome = await execVerb(step, ctx);
        run.log.push({
          step: run.stepIndex, verb: step.do, desc: step.desc,
          ok: true, note: outcome.note,
          at: new Date().toISOString(), tookMs: Date.now() - stepStart,
        });
        run.stepIndex += 1;
        run.stepsDone += 1;
      } catch (err) {
        const verbDesc = { index: run.stepIndex, verb: step.do, desc: step.desc };
        if (err instanceof VerbPause) {
          run.status = err.reason === "approval_required" || err.reason === "dry_run_stop" || err.reason === "missing_param"
            ? "paused_at_gate"
            : "paused";
          run.lastPause = { step: verbDesc, reason: err.reason, detail: err.detail, resumeHint: err.resumeHint };
          run.log.push({
            step: run.stepIndex, verb: step.do, desc: step.desc, ok: false,
            note: `paused: ${err.reason}`,
            at: new Date().toISOString(), tookMs: Date.now() - stepStart,
          });
        } else {
          // Unexpected step error → PAUSE (repairable), not failed: the agent
          // keeps the "LLM takes back control" contract and can resume once
          // the transient cause (navigation race, reconnect window, policy)
          // is resolved. Single automatic retry for likely-transient errors.
          const message = (err as Error).message;
          const transient =
            /navigation rejected|no extension connected|timed out|reconnect/i.test(message);
          if (transient && !(run as RunState & { retriedStep?: Set<number> }).retriedStep?.has(run.stepIndex)) {
            ((run as RunState & { retriedStep?: Set<number> }).retriedStep ??=
              new Set<number>()).add(run.stepIndex);
            run.log.push({
              step: run.stepIndex, verb: step.do, desc: step.desc, ok: false,
              note: `transient error, retrying once: ${message}`,
              at: new Date().toISOString(), tookMs: Date.now() - stepStart,
            });
            await new Promise((r) => setTimeout(r, 1500));
            continue; // re-run the same step
          }
          run.status = "paused";
          run.lastPause = {
            step: verbDesc,
            reason: "step_error",
            detail: { message },
            resumeHint: "Transient/unknown step error. Diagnose (flow_status, screenshot), fix if needed, then run_flow {resume}.",
          };
          run.log.push({
            step: run.stepIndex, verb: step.do, desc: step.desc, ok: false,
            note: `paused: step_error (${message})`,
            at: new Date().toISOString(), tookMs: Date.now() - stepStart,
          });
        }
        run.updatedAt = new Date().toISOString();
        run.elapsedMs = Date.now() - startedClock;
        saveRunState(this.deps.flowsDir, run);
        this.notifyWaiters(run.runId);
        this.deps.log?.(`[flow] ${run.runId} ${run.status} at step ${run.stepIndex} (${(err as Error).message})`);
        return;
      }

      run.updatedAt = new Date().toISOString();
      run.elapsedMs = Date.now() - startedClock;
      saveRunState(this.deps.flowsDir, run);
      if (stepDelayMs > 0) await new Promise((r) => setTimeout(r, stepDelayMs));
    }

    run.status = "completed";
    run.updatedAt = new Date().toISOString();
    run.elapsedMs = Date.now() - startedClock;
    saveRunState(this.deps.flowsDir, run);
    this.notifyWaiters(run.runId);
    this.deps.log?.(`[flow] ${run.runId} completed (${run.stepsDone} steps)`);
  }
}
