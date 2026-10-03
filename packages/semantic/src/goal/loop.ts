// GoalRunner — the daemon-side goal loop (port of jev-ultrafast `agent.py`).
//
// Control flow lives HERE, in code. Jev only answers "which operation, which
// target" once per cycle (one TypeSafe request, no LLM turn). A generative model
// is consulted only when the chosen operation is TYPE_TEXT.
//
// Safety rules ported from the original, in order of importance:
//   1. A decision is bound to the observation it was made on (freshness marker).
//   2. The decision is consumed BEFORE any mutation — a retry cannot double-click.
//   3. Execution is logged BEFORE the page is observed again.
//   4. Never retry a browser mutation.
//   5. Target occlusion/staleness is re-checked immediately before input.
//   6. Three consecutive steps without a page change stop the run (no livelock).
//   7. DONE is not proof: the caller verifies the outcome independently.

import { randomUUID } from "node:crypto";
import { authorizeGoalAction, parseGoalSafety, isAllowedGoalPage, tryAdmitOrigin, type GoalSafety, GOAL_PROTOCOL_VERSION } from './safety.js';
import fs from "node:fs";
import path from "node:path";
import type { SemanticConfig, SideToolCall, Logger } from "../types.js";
import type { JevClient } from "../jev/client.js";
import { choose, type Decision, type HistoryEntry } from "./choose.js";
import type { ObservationAction } from "./action-space.js";
import { actionTargetGuard } from "./action-space.js";
import { MAX_STEPS } from "./questions.js";
import { createTextHelper, type FieldContext, type TextHelper } from "./text-helper.js";

export type GoalStatus = "running" | "paused" | "completed" | "blocked" | "failed" | "stopped";

export interface GoalStepEntry {
  step: number;
  at: string;
  url?: string;
  operation: string;
  choice: string;
  target?: string | null;
  action?: string;
  kind?: string;
  confidence: number;
  probability?: number;
  text?: string | null;
  textHelper?: string | null;
  latencyMs?: number;
  decisionMs?: number;
  pageChanged?: boolean | null;
  executedMs?: number;
  note?: string;
}

export interface GoalPause {
  reason: string;
  detail?: unknown;
  resumeHint?: string;
}

export interface GoalRunState {
  runId: string;
  kind: "goal";
  requestId?: string;
  goal: string;
  status: GoalStatus;
  tabId?: number;
  dryRun: boolean;
  safety?: GoalSafety;
  expiresAt?: number;
  maxSteps: number;
  stepIndex: number;
  steps: GoalStepEntry[];
  decisions: number;
  textCalls: number;
  /** B2/O7 — plafond d'appels au helper texte pour ce run. */
  maxTextCalls?: number;
  stopRequested: boolean;
  evaluateAvailable: boolean;
  startedAt: string;
  updatedAt: string;
  elapsedMs: number;
  lastPage?: { url?: string; title?: string; marker?: string; scrollY?: number; note?: string };
  lastPause?: GoalPause;
  /** Wall guard ran for this run (reset on resume so a wall can be re-checked). */
  triageDone?: boolean;
  /** Targets that vanished before execution (bounded). */
  staleRetries?: number;
  /** L3 — last generated value per field node; reuse must NOT use the P10 page marker. */
  typedByNode?: Record<string, string>;
  noopFills?: number;
  /** Last hint actually consumed by resume(); a duplicate is not new context. */
  lastConsumedHint?: string;
  originAdmitted?: { origin: string; token: string; url?: string };
  lastDecision?: Pick<Decision, "choice" | "operation" | "target" | "confidence" | "probabilities" | "operationProbabilities">;
  usage: { inputTokens: number; outputTokens: number; cachedAnswers: number };
  model?: string;
  error?: string;
}

interface Observation {
  ok?: boolean;
  error?: string;
  url?: string;
  title?: string;
  text?: string;
  w?: number;
  h?: number;
  marker?: string;
  actions?: ObservationAction[];
  omitted_actions?: number;
  guards?: Record<string, unknown[]>;
  scroll?: { y: number; height: number };
}

export interface GoalRunnerDeps {
  config: SemanticConfig;
  jev: JevClient;
  goalsDir: string;
  log?: Logger;
  /** Injectable for tests. */
  textHelper?: TextHelper;
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
  /**
   * B2/O7 — plafond d'appels au helper TEXTE par run (défaut
   * `DEFAULT_MAX_TEXT_CALLS`). Le helper est la seule appel génératif de la
   * boucle : sans plafond, un but ambigu pouvait en consommer un nombre non borné
   * (chaque TYPE_TEXT = un appel payant).
   */
  maxTextCalls?: number;
}

const MAX_WAIT_MS = 120_000;
const POST_TYPE_SETTLE_MS = 200;
const POST_SCROLL_SETTLE_MS = 250;
const WAIT_MS = 600;
/**
 * B2/O7 — plafond d'appels au helper texte par run. Volontairement bas : un but
 * normal remplit quelques champs, pas trente. Dépasser ce plafond signale un but
 * ou une page ambigus, pas un besoin légitime.
 */
const DEFAULT_MAX_TEXT_CALLS = 12;
/** Plafond dur, même si l'appelant en demande plus (borne le coût par run). */
const HARD_MAX_TEXT_CALLS = 50;
const NO_PROGRESS_STEPS = 3;
/** A target that vanished between observation and execution is re-observed this many times. */
const MAX_STALE_TARGET_RETRIES = 3;
/** Failures that happen BEFORE anything is dispatched: nothing was mutated. */
const PRE_EXECUTION_FAILURE = /not found|disappeared|no longer found|is stale|unknown node/i;
/** Bounded re-observation after an action: a click that navigates has no body for an instant. */
const OBSERVE_BACKOFF_MS = [150, 300, 600, 1200];

export const SELECT_EXPRESSION = (nodeId: string, value: string) => `
(() => {
  const el = document.querySelector('[data-wb-id=${JSON.stringify(nodeId)}]');
  if (!el) return { found: false };
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  if (setter) setter.call(el, ${JSON.stringify(value)});
  else el.value = ${JSON.stringify(value)};
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { found: true, value: String(el.value) };
})()`;

/**
 * TEXT entry via the native value setter, the same technique the flow runner
 * uses (`fill_native`). Preferred over `type_element` for two reasons:
 *   1. framework-safe: React/Vue controlled inputs see a real `input` event;
 *   2. robustness: repeated `type_element` calls intermittently kill the CDP
 *      session for the tab. Multi-field goals must not depend on it.
 *
 * DO NOT add `el.focus()` here. Measured on Chrome 2026-09: calling focus()
 * inside a CDP Runtime.evaluate drops the tab's `chrome.debugger` attachment
 * for good (every later attach fails with "Cannot access a chrome-extension://
 * URL of different extension" until the document is replaced). The same trap
 * exists in any fill helper that focuses the target; `blur()` alone and the
 * `input`/`change` events are safe.
 */
export const FILL_EXPRESSION = (nodeId: string, value: string) => `
(() => {
  const el = document.querySelector('[data-wb-id=${JSON.stringify(nodeId)}]');
  if (!el) return { found: false };
  if ('value' in el) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) {
      setter.call(el, '');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      setter.call(el, ${JSON.stringify(value)});
    } else {
      el.value = ${JSON.stringify(value)};
    }
  } else {
    el.textContent = ${JSON.stringify(value)};
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { found: true, value: 'value' in el ? String(el.value) : String(el.textContent) };
})()`;

/** Default wall guard threshold (see SemanticConfig.goalTriageMinElements). */
const DEFAULT_TRIAGE_MIN_ELEMENTS = 10;

/**
 * Terminal decisions (DONE/BLOCKED) do not mutate anything and their outcome is
 * never trusted without independent verification, so gating them at the *action*
 * floor is over-conservative: measured on the 13-scenario suite, a satisfied
 * goal paused instead of completing because the model declared DONE at 0.4.
 */
const TERMINAL_MIN_CONFIDENCE = 0.35;

/** Compatible controls in an observation: the page is usable for a decision. */
function countInteractive(observation: Observation): number {
  return (observation.actions ?? []).filter(
    (action) => action.node && ["click", "fill", "select"].includes(String(action.kind))
  ).length;
}

function goalDir(goalsDir: string, runId: string): string {
  return path.join(goalsDir, runId);
}

function saveGoalState(goalsDir: string, state: GoalRunState): void {
  const dir = goalDir(goalsDir, state.runId);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, "state.json.tmp");
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
  fs.renameSync(tmp, path.join(dir, "state.json"));
}

function loadGoalState(goalsDir: string, runId: string): GoalRunState | undefined {
  try {
    const file = path.join(goalDir(goalsDir, runId), "state.json");
    if (!fs.existsSync(file)) return undefined;
    return JSON.parse(fs.readFileSync(file, "utf-8")) as GoalRunState;
  } catch {
    return undefined;
  }
}

export class GoalRunner {
  private runs = new Map<string, GoalRunState>();
  private waiters = new Map<string, Array<() => void>>();
  /** B2/P08 : starts concurrents du même requestId partagent la même promesse. */
  private pendingStarts = new Map<string, Promise<GoalRunState>>();
  private readonly textHelper: TextHelper;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private deps: GoalRunnerDeps) {
    this.textHelper =
      deps.textHelper ??
      createTextHelper(
        {
          apiKey: deps.config.textModelApiKey,
          baseUrl: deps.config.textModelBaseUrl,
          model: deps.config.textModelId,
          reasoning: deps.config.textModelReasoning,
        },
        deps.fetchImpl ?? fetch
      );
    this.sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private readonly instanceId = randomUUID();
  capabilities() {
    return { protocolVersion: GOAL_PROTOCOL_VERSION, instanceId: this.instanceId, textHelperConfigured: Boolean(this.deps.textHelper || this.deps.config.textModelApiKey) };
  }

  /**
   * B2/P08 — cherche un run par `requestId` sur le DISQUE, pas seulement en mémoire.
   *
   * Avant ce correctif, le rejeu ne consultait que `this.runs` : après un restart
   * du daemon la carte était vide, donc un `run_goal` rejoué par le client
   * (réponse de start perdue, retry réseau) créait un NOUVEAU run — et donc une
   * seconde exécution du même objectif sur la même page (risque de double clic).
   * `requestId` étant déjà persisté dans `state.json`, la recherche disque suffit :
   * aucun changement du daemon n'est nécessaire.
   */
  private findByRequestId(requestId: string): GoalRunState | undefined {
    const active = [...this.runs.values()].find((r) => r.requestId === requestId);
    if (active) return active;
    let ids: string[] = [];
    try {
      ids = fs
        .readdirSync(this.deps.goalsDir)
        .filter((name) => fs.existsSync(path.join(this.deps.goalsDir, name, "state.json")));
    } catch {
      return undefined;
    }
    const matches = ids
      .map((id) => loadGoalState(this.deps.goalsDir, id))
      .filter((s): s is GoalRunState => !!s && s.requestId === requestId)
      // Le plus récent d'abord : un requestId réutilisé après un long délai ne
      // doit pas ressusciter un run historique.
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    const found = matches[0];
    if (!found) return undefined;
    // Revue @agent-f98af5 : un run relu sur disque peut être encore marqué
    // `running` alors que la boucle qui l'exécutait est MORTE (restart du
    // daemon). Renvoyer ce snapshot tel quel ferait croire à un run actif, et
    // l'appelant rejouerait un objectif déjà abandonné. On passe donc par
    // `status()`, qui le bascule en `paused` avec
    // `daemon_restarted_effect_unknown` et le persiste. JAMAIS de relance
    // automatique de la boucle : seul l'appelant décide, après observation.
    const reconciled = this.status(found.runId);
    if (!reconciled) return undefined;
    // Réenregistrer en mémoire : le run existe à nouveau côté instance courante.
    this.runs.set(reconciled.runId, reconciled);
    return reconciled;
  }

  /**
   * B2/P08 — comparaison de la REQUÊTE rejouée. Un `requestId` identique portant
   * une demande différente n'est pas un rejeu : c'est un conflit, refusé
   * explicitement (jamais un nouveau run silencieux).
   */
  private requestMatches(replay: GoalRunState, goal: string, input: { tabId?: number; dryRun?: boolean; safety?: GoalSafety }): boolean {
    if (replay.goal !== goal) return false;
    if (replay.tabId !== input.tabId) return false;
    if (replay.dryRun !== (input.dryRun === true)) return false;
    const a = replay.safety ? JSON.stringify(replay.safety) : null;
    const b = input.safety ? JSON.stringify(input.safety) : null;
    return a === b;
  }

  status(runId: string): GoalRunState | undefined {
    const active = this.runs.get(runId);
    if (active) return active;
    const saved = loadGoalState(this.deps.goalsDir, runId);
    if (saved?.status === 'running') {
      saved.status = 'paused';
      saved.lastPause = { reason: 'daemon_restarted_effect_unknown', resumeHint: 'Inspect the actual page before starting any new mutation.' };
      saveGoalState(this.deps.goalsDir, saved);
    }
    return saved;
  }

  listRuns(limit = 20): Array<Pick<GoalRunState, "runId" | "requestId" | "tabId" | "goal" | "status" | "updatedAt" | "stepIndex" | "decisions">> {
    let ids: string[] = [];
    try {
      ids = fs
        .readdirSync(this.deps.goalsDir)
        .filter((name) => fs.existsSync(path.join(this.deps.goalsDir, name, "state.json")));
    } catch {
      ids = [];
    }
    const all = new Set([...ids, ...this.runs.keys()]);
    return [...all]
      .map((id) => this.status(id))
      .filter((s): s is GoalRunState => !!s)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .slice(0, limit)
      .map((s) => ({
        runId: s.runId,
        requestId: s.requestId,
        tabId: s.tabId,
        goal: s.goal,
        status: s.status,
        updatedAt: s.updatedAt,
        stepIndex: s.stepIndex,
        decisions: s.decisions,
      }));
  }

  /**
   * Fire-and-forget start. Returns the fresh run snapshot.
   *
   * B2/P08 : deux appels CONCURRENTS portant le même `requestId` ne créent qu'un
   * run — le second joint la promesse du premier. Sans cela, deux requêtes
   * simultanées (retry réseau + premier envoi) passaient toutes les deux le test
   * de rejeu avant que le run n'existe, et deux runs étaient lancés sur la même
   * page.
   */
  async start(
    call: SideToolCall,
    input: { goal: string; tabId?: number; maxSteps?: number; dryRun?: boolean; stepDelayMs?: number; budgetMs?: number; safety?: GoalSafety; requestId?: string }
  ): Promise<GoalRunState> {
    if (!input.requestId) return this.startOnce(call, input);
    const inFlight = this.pendingStarts.get(input.requestId);
    if (inFlight) return { ...(await inFlight) };
    const promise = this.startOnce(call, input);
    this.pendingStarts.set(input.requestId, promise);
    try {
      return await promise;
    } finally {
      // Une fois le run créé (ou l'échec survenu), la déduplication passe par le
      // rejeu persistant : la promesse n'a plus à être mémorisée.
      this.pendingStarts.delete(input.requestId);
    }
  }

  private async startOnce(
    call: SideToolCall,
    input: { goal: string; tabId?: number; maxSteps?: number; dryRun?: boolean; stepDelayMs?: number; budgetMs?: number; safety?: GoalSafety; requestId?: string }
  ): Promise<GoalRunState> {
    const goal = String(input.goal ?? "").trim();
    if (!goal) throw new Error("run_goal: {goal} is required");
    if (this.deps.jev.disabled) {
      throw new Error(
        "run_goal: no TypeSafe API key configured (TYPESAFE_API_KEY or WEBBRIDGE_JEV_API_KEY), so the decision loop cannot start."
      );
    }

    const safety = parseGoalSafety(input.safety);
    if (input.requestId !== undefined && !/^[a-zA-Z0-9-]{1,80}$/.test(input.requestId)) throw new Error('invalid_goal_request_id');
    // B2/P08 : rejeu cherché EN MÉMOIRE **et SUR DISQUE** (voir findByRequestId).
    if (input.requestId) {
      const replay = this.findByRequestId(input.requestId);
      if (replay) {
        if (!this.requestMatches(replay, goal, { tabId: input.tabId, dryRun: input.dryRun, safety })) {
          throw new Error('goal_request_conflict');
        }
        return { ...replay };
      }
    }
    if (safety && !Number.isInteger(input.tabId)) throw new Error('guarded_goal_requires_tab');
    // Checked again after observation: concurrent starts must not both acquire a tab.
    const assertTabFree = () => {
      if (input.tabId !== undefined && [...this.runs.values()].some(r => r.tabId === input.tabId && r.status === 'running')) {
        throw new Error('goal_tab_busy');
      }
    };
    assertTabFree();
    // Fail fast when the page cannot be observed at all.
    const probe = await this.observe(call, input.tabId, { requireUseful: true });
    if (!probe || probe.ok === false) {
      throw new Error(`run_goal: action_space failed: ${probe?.error ?? "unknown error"}`);
    }

    assertTabFree();
    if (safety && !isAllowedGoalPage(probe.url, safety)) throw new Error('outside_allowed_origin');
    const now = new Date().toISOString();
    const budgetMs = Number.isFinite(input.budgetMs) ? Math.min(Math.max(input.budgetMs!, 100), 300_000) : 90_000;
    const maxTextCalls = Number.isFinite(Number(this.deps.maxTextCalls))
      ? Math.min(Math.max(Number(this.deps.maxTextCalls), 1), HARD_MAX_TEXT_CALLS)
      : DEFAULT_MAX_TEXT_CALLS;
    const run: GoalRunState = {
      runId: `g_${randomUUID().slice(0, 12)}`,
      kind: "goal",
      requestId: input.requestId,
      goal,
      status: "running",
      tabId: input.tabId,
      dryRun: input.dryRun === true,
      safety,
      expiresAt: Date.now() + budgetMs,
      maxSteps: Math.min(Math.max(input.maxSteps ?? MAX_STEPS, 1), MAX_STEPS),
      maxTextCalls,
      stepIndex: 0,
      steps: [],
      decisions: 0,
      textCalls: 0,
      stopRequested: false,
      evaluateAvailable: false,
      startedAt: now,
      updatedAt: now,
      elapsedMs: 0,
      lastPage: { url: probe.url, title: probe.title, marker: probe.marker, scrollY: probe.scroll?.y },
      usage: { inputTokens: 0, outputTokens: 0, cachedAnswers: 0 },
    };

    this.runs.set(run.runId, run);
    saveGoalState(this.deps.goalsDir, run);
    this.deps.log?.(`[goal] ${run.runId} started${run.dryRun ? " (dry-run)" : ""}: ${goal.slice(0, 120)}`);

    void this.loop(run, call, input.stepDelayMs ?? 0, probe).catch((err) => {
      run.status = "failed";
      run.error = String(err);
      run.updatedAt = new Date().toISOString();
      saveGoalState(this.deps.goalsDir, run);
      this.notifyWaiters(run.runId);
    });
    return { ...run };
  }

  /**
   * Continue a paused run from the current page.
   *
   * B2/P06+P09 — une reprise n'est jamais « la même chose en espérant mieux » :
   *  - P09 : un hint NON VIDE est obligatoire. Avant, un resume sans contexte
   *    repartait sur le même but, avec le même état de page et le même modèle :
   *    la cause de la pause était toujours là, donc la boucle re-pausait
   *    (ou pire, retentait la même action).
   *  - P06 : `observation_failed_after_action` signale qu'une mutation a été
   *    dispatchée SANS qu'on ait pu observer son effet. La reprendre serait
   *    traiter un effet inconnu comme une simple hésitation — exactement ce que
   *    la quarantaine interdit. Elle est donc refusée, avec un message qui dit
   *    quoi faire (inspecter la page).
   */
  async resume(
    call: SideToolCall,
    input: { runId: string; stepDelayMs?: number; hint?: string }
  ): Promise<GoalRunState> {
    const run = this.status(input.runId);
    if (!run) throw new Error(`run_goal: unknown run "${input.runId}"`);
    if (run.status !== "paused") {
      throw new Error(`run_goal: run "${input.runId}" is ${run.status} (only paused runs can resume)`);
    }
    if ((run.expiresAt ?? 0) <= Date.now() && run.expiresAt !== undefined) throw new Error('goal_budget_expired');
    if ([...this.runs.values()].some(r => r.runId !== run.runId && r.tabId === run.tabId && r.status === 'running')) throw new Error('goal_tab_busy');
    // P09 : refus d'une reprise sans nouveau contexte.
    const hint = typeof input.hint === "string" ? input.hint.trim() : "";
    if (!hint) {
      throw new Error('resume_requires_new_context');
    }
    if (run.lastConsumedHint === hint) {
      throw new Error('resume_hint_not_new');
    }
    run.lastConsumedHint = hint;
    // P06 : un effet INCONNU n'est pas une hésitation.
    if (run.lastPause?.reason === 'observation_failed_after_action') {
      throw new Error('resume_refused_effect_unknown: a mutation was dispatched without a usable observation; inspect the actual page (and the run state) before deciding anything.');
    }
    run.goal = `${run.goal}\n[Hint] ${hint.slice(0, 500)}`;
    run.status = "running";
    run.lastPause = undefined;
    run.stopRequested = false;
    run.triageDone = false; // a manual login/fix between pause and resume must be re-checked
    run.updatedAt = new Date().toISOString();
    this.runs.set(run.runId, run);
    saveGoalState(this.deps.goalsDir, run);
    this.deps.log?.(`[goal] ${run.runId} resumed at step ${run.stepIndex}`);
    // P06 : `undefined` en dernier argument impose une observation FRAÎCHE au
    // début de la boucle (le paramètre `firstObservation` est optionnel).
    void this.loop(run, call, input.stepDelayMs ?? 0, undefined).catch((err) => {
      run.status = "failed";
      run.error = String(err);
      saveGoalState(this.deps.goalsDir, run);
      this.notifyWaiters(run.runId);
    });
    return { ...run };
  }

  stop(runId: string): GoalRunState {
    const run = this.status(runId);
    if (!run) throw new Error(`goal_stop: unknown run "${runId}"`);
    if (run.status === "running") {
      run.stopRequested = true;
      saveGoalState(this.deps.goalsDir, run);
    } else if (run.status === 'paused') {
      run.stopRequested = true;
      this.finish(run, 'stopped');
    }
    return run;
  }

  /** Block until the run is terminal/paused (or timeout). Returns the snapshot. */
  async wait(runId: string, timeoutMs = 30_000): Promise<GoalRunState | undefined> {
    const bounded = Math.min(Math.max(timeoutMs, 100), MAX_WAIT_MS);
    const deadline = Date.now() + bounded;
    while (Date.now() < deadline) {
      const run = this.status(runId);
      if (!run || run.status !== "running") return run;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => resolve(), 250);
        const entry = () => {
          clearTimeout(timer);
          resolve();
        };
        const list = this.waiters.get(runId) ?? [];
        list.push(entry);
        this.waiters.set(runId, list);
      });
    }
    return this.status(runId);
  }

  private notifyWaiters(runId: string): void {
    for (const entry of this.waiters.get(runId) ?? []) entry();
    this.waiters.delete(runId);
  }

  /**
   * Observe with bounded retries. A navigation triggered by the previous
   * action leaves the document without a body — or with a not-yet-rendered
   * shell — for a moment, so a single read must not end the run.
   *
   * `requireUseful` keeps polling until the observation contains at least one
   * compatible control (the page settled), or until the same marker is read
   * twice in a row (the page is genuinely empty → let the model decide
   * DONE/BLOCKED/WAIT). Nothing is mutated here.
   */
  private async observe(
    call: SideToolCall,
    tabId?: number,
    options: { requireUseful?: boolean } = {}
  ): Promise<Observation> {
    let last: Observation = { ok: false, error: "action_space was never called" };
    let emptyMarker: string | undefined;
    const attempts = OBSERVE_BACKOFF_MS.length + 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        last = (await call("action_space", { tabId })) as Observation;
      } catch (err) {
        last = { ok: false, error: (err as Error).message };
      }
      if (last && last.ok !== false) {
        const informative = countInteractive(last);
        if (!options.requireUseful || informative > 0) return last;
        if (emptyMarker !== undefined && emptyMarker === last.marker) return last;
        emptyMarker = last.marker;
      }
      if (attempt < attempts - 1) await this.sleep(OBSERVE_BACKOFF_MS[attempt]);
    }
    return last;
  }

  private finish(run: GoalRunState, status: GoalStatus, pause?: GoalPause): void {
    run.status = status;
    if (pause) run.lastPause = pause;
    run.updatedAt = new Date().toISOString();
    saveGoalState(this.deps.goalsDir, run);
    this.notifyWaiters(run.runId);
    this.deps.log?.(`[goal] ${run.runId} → ${status}${pause ? ` (${pause.reason})` : ""}`);
  }

  private async loop(
    run: GoalRunState,
    call: SideToolCall,
    stepDelayMs: number,
    firstObservation?: Observation
  ): Promise<void> {
    const startedClock = Date.now() - run.elapsedMs;
    const tick = () => {
      run.elapsedMs = Date.now() - startedClock;
      run.updatedAt = new Date().toISOString();
    };

    // The evaluate gate governs whether native <select> options can be driven.
    if (!run.evaluateAvailable) {
      try {
        await call("evaluate", { expression: "1", ...(run.tabId !== undefined ? { tabId: run.tabId } : {}) });
        run.evaluateAvailable = true;
      } catch {
        run.evaluateAvailable = false;
      }
    }

    if (run.safety && !run.evaluateAvailable) return this.finish(run, 'paused', { reason: 'evaluate_required' });
    let observation: Observation | undefined = firstObservation;
    const history: HistoryEntry[] = run.steps.map((step) => ({
      action: step.action,
      kind: step.kind,
      text: step.text ?? null,
      page_changed: step.pageChanged ?? null,
    }));

    const interrupted = () => run.stopRequested || (run.expiresAt !== undefined && Date.now() >= run.expiresAt);
    while (true) {
      if (interrupted()) return this.finish(run, "stopped", { reason: run.stopRequested ? 'cancelled' : 'time_budget' });
      if (run.steps.length >= run.maxSteps) {
        return this.finish(run, "blocked", {
          reason: "step_budget",
          detail: { maxSteps: run.maxSteps },
          resumeHint: "Increase maxSteps or split the goal into smaller steps.",
        });
      }
      if (run.decisions >= run.maxSteps * 2) {
        return this.finish(run, "blocked", {
          reason: "decision_budget",
          detail: { decisions: run.decisions },
          resumeHint: "The loop decided many times without finishing; the goal or the page may be ambiguous.",
        });
      }

      if (!observation) {
        observation = await this.observe(call, run.tabId, { requireUseful: true });
      }
      if (!observation || observation.ok === false) {
        return this.finish(run, "paused", {
          reason: "observation_failed",
          detail: observation ?? null,
          resumeHint: "action_space failed (tab closed, chrome:// page, extension disconnected). Fix, then run_goal {resume}.",
        });
      }
      if (run.safety) {
        const admit = tryAdmitOrigin(run.safety, run.goal, observation.url);
        if (admit.origin && admit.token) {
          this.deps.log?.(`[goal] ${run.runId} origin admitted ${admit.origin} token=${admit.token} url=${observation.url}`);
          run.originAdmitted = { origin: admit.origin, token: admit.token, url: observation.url };
        }
        if (!admit.admitted) return this.finish(run, 'paused', { reason: 'outside_allowed_origin' });
      }
      if (stepDelayMs > 0) await this.sleep(stepDelayMs);

      // Wall guard (first observation only, cheap pages only): a login wall,
      // paywall, CAPTCHA or error shell would otherwise eat the step budget.
      const triageMin = this.deps.config.goalTriageMinElements ?? DEFAULT_TRIAGE_MIN_ELEMENTS;
      if (!run.triageDone) {
        run.triageDone = true;
        if (triageMin > 0 && countInteractive(observation) < triageMin) {
          let triage: { usable?: boolean; blockers?: string[]; annoyances?: string[]; relevance?: unknown } | undefined;
          try {
            triage = (await call("page_triage", {
              intent: run.goal,
              ...(run.tabId !== undefined ? { tabId: run.tabId } : {}),
            })) as typeof triage;
            tick();
          } catch (err) {
            // page_triage is optional: a failure must never block the goal.
            this.deps.log?.(`[goal] ${run.runId} page_triage failed: ${(err as Error).message}`);
          }
          if (triage && triage.usable === false) {
            return this.finish(run, "paused", {
              reason: "page_blocked",
              detail: {
                url: observation.url,
                blockers: triage.blockers ?? [],
                annoyances: triage.annoyances ?? [],
                triage,
              },
              resumeHint:
                "The page is not usable (login wall, paywall, CAPTCHA or error page). Resolve it manually (or navigate to the real target), then run_goal {resume}.",
            });
          }
        }
        saveGoalState(this.deps.goalsDir, run);
      }

      const observed = observation;
      const result = await choose(this.deps.jev, {
        goal: run.goal,
        page: {
          url: observed.url,
          title: observed.title,
          text: observed.text,
          w: observed.w,
          h: observed.h,
          marker: observed.marker,
        },
        actions: observed.actions ?? [],
        history,
        evaluateAvailable: run.evaluateAvailable,
      });
      run.decisions += 1;
      tick();

      if (!result.ok) {
        return this.finish(run, "paused", {
          reason: result.error.split(":")[0] || "decision_failed",
          detail: { error: result.error },
          resumeHint:
            "Decision unavailable (Jev error, malformed answer, or no actionable element). Diagnose with page_triage, then run_goal {resume}.",
        });
      }

      const decision = result.decision;
      if (result.warning) {
        run.lastPage = { ...run.lastPage, note: result.warning };
      }
      if (decision.usage?.input_tokens) run.usage.inputTokens += decision.usage.input_tokens;
      if (decision.usage?.output_tokens) run.usage.outputTokens += decision.usage.output_tokens;
      if (decision.cached) run.usage.cachedAnswers += 1;
      run.model = decision.model ?? run.model;
      run.lastDecision = {
        choice: decision.choice,
        operation: decision.operation,
        target: decision.target,
        confidence: decision.confidence,
        probabilities: decision.probabilities,
        operationProbabilities: decision.operationProbabilities,
      };
      saveGoalState(this.deps.goalsDir, run);

      if (run.dryRun) {
        return this.finish(run, "paused", {
          reason: "dry_run",
          detail: {
            planned: {
              operation: decision.operation,
              choice: decision.choice,
              target: decision.target,
              action: (observed.actions ?? []).find((a) => a.id === decision.choice)?.label,
              confidence: decision.confidence,
              probability: decision.probabilities[decision.choice],
            },
            elements: result.space.elements.length,
          },
          resumeHint: "Dry run only: nothing was executed. Re-run without dryRun to execute.",
        });
      }

      // Confidence gate (plan §4.5): the model tells us what, the confidence
      // tells us whether to act. Below the floor nothing is executed — not even
      // a terminal DONE/BLOCKED — and the alternatives are surfaced so a human
      // (or an agent turn) can disambiguate. Terminals get a lower floor: they
      // do not mutate anything and their outcome is verified independently, so
      // requiring the action floor made satisfied goals pause (measured).
      const minConfidence = this.deps.config.jevMinConfidence ?? 0.5;
      const isTerminal = decision.choice === "DONE" || decision.choice === "BLOCKED" ||
        decision.operation === "DONE" || decision.operation === "BLOCKED";
      const isWait = decision.choice === "WAIT" || decision.operation === "WAIT" || String(decision.choice).toLowerCase() === "wait";
      const floor = isWait
        ? Math.min(minConfidence, 0.15)
        : isTerminal
          ? Math.min(minConfidence, TERMINAL_MIN_CONFIDENCE)
          : minConfidence;
      const effectiveConfidence = Math.min(decision.confidence, decision.targetConfidence ?? 1);
      if (effectiveConfidence < floor) {
        const top = Object.entries(decision.operationProbabilities)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([id, p]) => ({ option: id, probability: Number(p.toFixed(3)) }));
        run.steps.push({
          step: run.steps.length + 1,
          at: new Date().toISOString(),
          url: observed.url,
          operation: decision.operation,
          choice: decision.choice,
          target: decision.target,
          action: (observed.actions ?? []).find((a) => a.id === decision.choice)?.label,
          kind: (observed.actions ?? []).find((a) => a.id === decision.choice)?.kind,
          confidence: decision.confidence,
          probability: decision.probabilities[decision.choice],
          note: `not executed: operation/target confidence ${effectiveConfidence.toFixed(2)} < ${floor}`,
          pageChanged: false,
          executedMs: run.elapsedMs,
        });
        tick();
        return this.finish(run, "paused", {
          reason: "low_confidence",
          detail: {
            url: observed.url,
            confidence: effectiveConfidence,
            targetConfidence: decision.targetConfidence,
            threshold: floor,
            terminal: isTerminal,
            proposed: {
              operation: decision.operation,
              choice: decision.choice,
              target: decision.target,
              action: (observed.actions ?? []).find((a) => a.id === decision.choice)?.label,
            },
            operation_probabilities: decision.operationProbabilities,
            alternatives: top,
            elements: result.space.elements.length,
          },
          resumeHint:
            "The model was not confident enough to act (nothing was executed). Clarify the goal, narrow the page, or act manually, then run_goal {resume}.",
        });
      }

      if (interrupted()) return this.finish(run, 'stopped', { reason: 'cancelled_or_expired' });
      // Terminal decisions must be justified by a still-fresh observation.
      if (isTerminal) {
        const verify = await this.observe(call, run.tabId);
        tick();
        if (!verify || verify.ok === false || verify.marker !== observed.marker) {
          observation = verify && verify.ok !== false ? verify : undefined;
          continue;
        }
        if (interrupted()) return this.finish(run, 'stopped', { reason: 'cancelled_or_expired' });
        const done = decision.choice === "DONE" || decision.operation === "DONE";
        const belowActionFloor = decision.confidence < minConfidence;
        run.lastPage = {
          url: verify.url,
          title: verify.title,
          marker: verify.marker,
          scrollY: verify.scroll?.y,
        };
        run.steps.push({
          step: run.steps.length + 1,
          at: new Date().toISOString(),
          url: observed.url,
          operation: decision.operation,
          choice: decision.choice,
          confidence: decision.confidence,
          note: done
            ? `model reports the goal satisfied${belowActionFloor ? ` (confidence ${decision.confidence.toFixed(2)} is below the action floor ${minConfidence} — verify independently)` : ""} — verify the outcome independently`
            : `model reports no supported operation can progress (confidence ${decision.confidence.toFixed(2)})`,
          pageChanged: false,
          executedMs: run.elapsedMs,
        });
        tick();
        return this.finish(run, done ? "completed" : "blocked", {
          reason: done ? "done" : "blocked_by_model",
          detail: {
            url: verify.url,
            title: verify.title,
            confidence: decision.confidence,
            interactive_elements: result.space.elements.length,
          },
          resumeHint: done
            ? "Confirm the outcome independently (DOM/text check) before trusting it."
            : "Provide a clearer goal, a different tab, or act manually. If the page should have controls, run page_triage first (login wall, CAPTCHA, unrendered shell).",
        });
      }

      const action = (observed.actions ?? []).find((item) => item.id === decision.choice);
      if (!action) {
        // The action disappeared between observation and execution: re-observe.
        history.push({ action: `missing:${decision.choice}`, kind: "stale", page_changed: false });
        observation = undefined;
        continue;
      }

      // TEST-ONLY: WEBBRIDGE_GOAL_SKIP_SAFETY=1 saute HARD_DENY + classify d'effet.
      // Défaut = safety ON. Ne pas utiliser hors banc / démo locale.
      const skipSafety = process.env.WEBBRIDGE_GOAL_SKIP_SAFETY === '1';
      if (run.safety && !skipSafety) {
        const permission = await authorizeGoalAction(this.deps.jev, { goal: run.goal, url: observed.url, pageText: observed.text, action, safety: run.safety });
        if (!permission.ok) return this.finish(run, 'paused', { reason: 'authorization_required', detail: permission });
        const fresh = await this.observe(call, run.tabId);
        if (fresh?.ok === false || !fresh?.marker || fresh.marker !== observed.marker) { observation = undefined; continue; }
      } else if (run.safety && skipSafety) {
        this.deps.log?.(`[goal] ${run.runId} SAFETY SKIPPED (WEBBRIDGE_GOAL_SKIP_SAFETY=1) action=${action.label}`);
      }
      if (interrupted()) return this.finish(run, 'stopped', { reason: 'cancelled_or_expired' });
      // Consume the decision before mutating: a retry must not repeat it.
      const kind = String(action.kind ?? "click");
      const rect = action.rect;
      const centerX = rect ? Math.round(rect.x + rect.w / 2) : undefined;
      const centerY = rect ? Math.round(rect.y + rect.h / 2) : undefined;

      // Re-check staleness/occlusion immediately before input.
      //
      // `element_info` reports the topmost element at a point, so:
      //   - a DIFFERENT tracked element covering the point  → reject (real occlusion)
      //   - nothing at the point (background window, point outside the visual
      //     viewport)                                        → accept: the marker
      //     check already covers staleness, and click_element re-resolves the
      //     node's CURRENT geometry from `data-wb-id` (never our stale rect)
      //   - an untracked element (child span, overlay)       → accept: clicks bubble
      if (kind !== "scroll" && kind !== "wait" && action.node && centerX !== undefined && centerY !== undefined) {
        const info = (await call("element_info", { x: centerX, y: centerY, tabId: run.tabId })) as {
          found?: boolean;
          element?: { wbId?: string };
        };
        const covering = info?.found === true ? info.element?.wbId : undefined;
        if (covering && covering !== action.node) {
          run.steps.push({
            step: run.steps.length + 1,
            at: new Date().toISOString(),
            url: observed.url,
            operation: decision.operation,
            choice: decision.choice,
            target: decision.target,
            action: action.label,
            kind,
            confidence: decision.confidence,
            note: "skipped: target moved, disappeared, or is covered",
            pageChanged: false,
            executedMs: run.elapsedMs,
          });
          history.push({ action: action.label, kind, text: null, page_changed: false });
          observation = undefined;
          tick();
          saveGoalState(this.deps.goalsDir, run);
          continue;
        }
      }

      if (interrupted()) return this.finish(run, 'stopped', { reason: 'cancelled_or_expired' });

      // P10 — GUARD DE CIBLE. Le marker ne couvre PAS href/form-action : un lien
      // dont le libellé reste identique peut pointer ailleurs après un
      // re-rendu (recommandations, A/B, contenu chargé tardivement). On compare
      // la cible qui a servi à la DÉCISION à une observation FRAÎCHE prise juste
      // avant le dispatch, et on ne dispatche rien si elle a changé.
      //
      // L'observation fraîche est indispensable : relire `observed` (celle de la
      // décision) ne détecterait jamais rien. Si elle échoue, on ne dispatche
      // pas non plus — on ne peut pas prouver que la cible est la bonne.
      //   - cible absente des deux côtés : pas un changement (scroll/wait, ou
      //     extension plus ancienne sans ces champs) ;
      //   - cible qui apparaît ou disparaît : c'est un changement.
      const decidedGuard = actionTargetGuard(action);
      if (decidedGuard !== null) {
        const fresh = await this.observe(call, run.tabId, { requireUseful: true });
        tick();
        if (!fresh || fresh.ok === false) {
          return this.finish(run, "paused", {
            // Pré-exécution : RIEN n'a été dispatché. Utiliser
            // `observation_failed_after_action` ici serait un mensonge ET un
            // deadlock depuis P06 (qui refuse désormais de reprendre cette
            // raison, à juste titre : elle signifie « effet inconnu »).
            reason: "observation_failed",
            detail: fresh ?? null,
            resumeHint: "The target could not be re-checked before the action; nothing was dispatched. Fix, then run_goal {resume}.",
          });
        }
        const freshAction =
          (fresh.actions ?? []).find((candidate) => candidate.node === action.node && candidate.kind === action.kind) ??
          (fresh.actions ?? []).find((candidate) => candidate.node === action.node);
        const freshGuard = actionTargetGuard(freshAction);
        if (freshGuard !== decidedGuard) {
        run.steps.push({
          step: run.steps.length + 1,
          at: new Date().toISOString(),
          url: observed.url,
          operation: decision.operation,
          choice: decision.choice,
          target: decision.target,
          action: action.label,
          kind,
          confidence: decision.confidence,
          note: "skipped: target changed since the decision (href/form-action/target)",
          pageChanged: false,
          executedMs: run.elapsedMs,
        });
        history.push({ action: action.label, kind, text: null, page_changed: false });
        // La page a bougé sous la décision : observation fraîche au tour suivant.
        observation = undefined;
        tick();
        saveGoalState(this.deps.goalsDir, run);
        continue;
      }
      }

      let typed: string | null = null;
      let helper: string | null = null;
      const executedAt = Date.now();
      try {
        if (kind === "fill") {
          const currentValue = String(action.value ?? action.current_value ?? "");
          const previous = action.node ? run.typedByNode?.[action.node] : undefined;
          if (action.node && previous && currentValue && previous === currentValue) {
            run.noopFills = (run.noopFills ?? 0) + 1;
            run.steps.push({
              step: run.steps.length + 1,
              at: new Date().toISOString(),
              url: observed.url,
              operation: decision.operation,
              choice: decision.choice,
              target: decision.target,
              action: action.label,
              kind,
              confidence: decision.confidence,
              note: "skipped: field already has generated value",
              pageChanged: false,
              executedMs: run.elapsedMs,
            });
            history.push({ action: action.label, kind, text: currentValue, page_changed: false });
            tick();
            saveGoalState(this.deps.goalsDir, run);
            if (run.noopFills >= 2) {
              return this.finish(run, "paused", {
                reason: "field_already_has_value",
                detail: { field: action.label, value: currentValue },
                resumeHint:
                  "The field already contains the generated value. Do not TYPE_TEXT again; CLICK the matching control (submit, suggestion, or result).",
              });
            }
            observation = undefined;
            continue;
          }
          const context: FieldContext = {
            goal: run.goal,
            field: { label: action.label, role: action.role, value: action.value },
            page: { title: observed.title, text: (observed.text ?? "").slice(0, 6000) },
            recent_actions: history.slice(-6).map((entry) => ({ action: entry.action, text: entry.text })),
          };
          // B2/O7 : refus AVANT l'appel payant, pas après.
          const textBudget = run.maxTextCalls ?? DEFAULT_MAX_TEXT_CALLS;
          if (run.textCalls >= textBudget) {
            tick();
            return this.finish(run, "paused", {
              reason: "text_call_budget",
              detail: { textCalls: run.textCalls, maxTextCalls: textBudget, field: action.label },
              resumeHint:
                "The text helper call budget for this run is exhausted. Fill the remaining fields manually (or split the goal), then run_goal {resume} with the new context.",
            });
          }
          const written = await this.textHelper(context);
          if (interrupted()) return this.finish(run, 'stopped', { reason: 'cancelled_or_expired' });
          if (!written.ok) {
            tick();
            return this.finish(run, "paused", {
              reason: written.error.split(":")[0] || "text_helper_failed",
              detail: { error: written.error, field: action.label },
              resumeHint:
                "TYPE_TEXT needs the text helper (TEXT_MODEL_API_KEY), or fill the field manually, then run_goal {resume}.",
            });
          }
          typed = written.text;
          helper = written.meta.model;
          run.textCalls += 1;
          if (interrupted()) return this.finish(run, 'stopped', { reason: 'cancelled_or_expired' });
          if (run.safety) {
            const fresh = await this.observe(call, run.tabId);
            if (fresh?.ok === false || !fresh?.marker || fresh.marker !== observed.marker) { observation = undefined; continue; }
            if (interrupted()) return this.finish(run, 'stopped', { reason: 'cancelled_or_expired' });
          }
          if (run.evaluateAvailable) {
            const rawWritten = (await call("evaluate", {
              expression: FILL_EXPRESSION(String(action.node), typed),
              ...(run.tabId !== undefined ? { tabId: run.tabId } : {}),
            })) as { value?: unknown; found?: boolean } | undefined;
            const written2 = (typeof rawWritten?.value === 'object' ? rawWritten.value : rawWritten) as { found?: boolean; value?: string } | undefined;
            if (run.safety && (written2?.found !== true || written2.value !== typed)) throw new Error('field_value_not_verified');
            if (written2 && written2.found === false) {
              run.steps.push({
                step: run.steps.length + 1,
                at: new Date().toISOString(),
                url: observed.url,
                operation: decision.operation,
                choice: decision.choice,
                target: decision.target,
                action: action.label,
                kind,
                confidence: decision.confidence,
                note: "skipped: field no longer found",
                pageChanged: false,
                executedMs: run.elapsedMs,
              });
              observation = undefined;
              tick();
              saveGoalState(this.deps.goalsDir, run);
              continue;
            }
          } else {
            // No evaluate gate: `type_element {focus:false}` writes through the
            // native setter, i.e. the same reliable, focus-free path.
            await call("type_element", {
              nodeId: action.node,
              text: typed,
              clearFirst: true,
              focus: false,
              ...(run.tabId !== undefined ? { tabId: run.tabId } : {}),
            });
          }
          await this.sleep(POST_TYPE_SETTLE_MS);
          if (action.node && typed) {
            run.typedByNode = { ...(run.typedByNode ?? {}), [action.node]: typed };
          }
        } else if (kind === "select") {
          const rawOutcome = (await call("evaluate", {
            expression: SELECT_EXPRESSION(String(action.node), String(action.value ?? "")),
            ...(run.tabId !== undefined ? { tabId: run.tabId } : {}),
          })) as { value?: unknown; found?: boolean } | undefined;
          const outcome = (typeof rawOutcome?.value === 'object' ? rawOutcome.value : rawOutcome) as { found?: boolean; value?: string } | undefined;
          if (run.safety && (outcome?.found !== true || outcome.value !== String(action.value ?? ''))) throw new Error('select_value_not_verified');
          if (outcome && outcome.found === false) {
            run.steps.push({
              step: run.steps.length + 1,
              at: new Date().toISOString(),
              url: observed.url,
              operation: decision.operation,
              choice: decision.choice,
              target: decision.target,
              action: action.label,
              kind,
              confidence: decision.confidence,
              note: "skipped: select element no longer found",
              pageChanged: false,
              executedMs: run.elapsedMs,
            });
            observation = undefined;
            tick();
            saveGoalState(this.deps.goalsDir, run);
            continue;
          }
        } else if (kind === "scroll") {
          await call("scroll", {
            x: Math.round((observed.w ?? 1280) / 2),
            y: Math.round((observed.h ?? 800) / 2),
            deltaY: Number(action.delta ?? 560),
            ...(run.tabId !== undefined ? { tabId: run.tabId } : {}),
          });
          await this.sleep(POST_SCROLL_SETTLE_MS);
        } else if (kind === "wait") {
          await this.sleep(WAIT_MS);
        } else {
          await call("click_element", {
            nodeId: action.node,
            ...(run.tabId !== undefined ? { tabId: run.tabId } : {}),
          });
        }
      } catch (err) {
        const message = (err as Error).message;
        // A failure BEFORE dispatch means nothing was mutated (click_element
        // resolves the id first and throws "node ... not found"; the page may
        // simply have re-rendered since the observation). That is safe to
        // retry: re-observe, decide again, bounded.
        const preExecution = PRE_EXECUTION_FAILURE.test(message);
        const staleRetries = run.staleRetries ?? 0;
        run.steps.push({
          step: run.steps.length + 1,
          at: new Date().toISOString(),
          url: observed.url,
          operation: decision.operation,
          choice: decision.choice,
          target: decision.target,
          action: action.label,
          kind,
          confidence: decision.confidence,
          probability: decision.probabilities[decision.choice],
          text: typed,
          textHelper: helper,
          latencyMs: Date.now() - executedAt,
          note: `${preExecution ? "stale target" : "execution error"}: ${message}`,
          pageChanged: null,
          executedMs: run.elapsedMs,
        });
        tick();
        if (preExecution && staleRetries < MAX_STALE_TARGET_RETRIES) {
          run.staleRetries = staleRetries + 1;
          history.push({ action: action.label, kind, text: typed, page_changed: false });
          observation = undefined;
          saveGoalState(this.deps.goalsDir, run);
          this.deps.log?.(
            `[goal] ${run.runId} target vanished before execution (retry ${run.staleRetries}/${MAX_STALE_TARGET_RETRIES}): ${action.label}`
          );
          continue;
        }
        return this.finish(run, "paused", {
          reason: preExecution ? "stale_target" : "execution_error",
          detail: {
            message,
            action: action.label,
            kind,
            retries: run.staleRetries ?? 0,
          },
          resumeHint: preExecution
            ? "The target kept disappearing before input (the page re-renders it). Inspect the page, then run_goal {resume}."
            : "A browser mutation failed and is NEVER retried automatically. Inspect the page, then run_goal {resume} to decide again.",
        });
      }

      // Log execution BEFORE observing the result.
      const entry: GoalStepEntry = {
        step: run.steps.length + 1,
        at: new Date().toISOString(),
        url: observed.url,
        operation: decision.operation,
        choice: decision.choice,
        target: decision.target,
        action: action.label,
        kind,
        confidence: decision.confidence,
        probability: decision.probabilities[decision.choice],
        text: typed,
        textHelper: helper,
        latencyMs: Date.now() - executedAt,
        decisionMs: decision.tookMs,
        pageChanged: null,
        executedMs: run.elapsedMs,
      };
      run.steps.push(entry);
      history.push({ action: action.label, kind, text: typed, page_changed: null });
      tick();
      saveGoalState(this.deps.goalsDir, run);

      observation = await this.observe(call, run.tabId, { requireUseful: true });
      tick();
      if (!observation || observation.ok === false) {
        return this.finish(run, "paused", {
          reason: "observation_failed_after_action",
          detail: observation ?? null,
          resumeHint: "The page could not be observed after an action (navigation, tab close). Fix, then run_goal {resume}.",
        });
      }
      entry.pageChanged = observation.marker !== observed.marker;
      history[history.length - 1].page_changed = entry.pageChanged;
      run.lastPage = {
        url: observation.url,
        title: observation.title,
        marker: observation.marker,
        scrollY: observation.scroll?.y,
      };
      saveGoalState(this.deps.goalsDir, run);
      if (run.safety) {
        const admit = tryAdmitOrigin(run.safety, run.goal, observation.url);
        if (admit.origin && admit.token) {
          this.deps.log?.(`[goal] ${run.runId} origin admitted ${admit.origin} token=${admit.token} url=${observation.url}`);
          run.originAdmitted = { origin: admit.origin, token: admit.token, url: observation.url };
        }
        if (!admit.admitted) return this.finish(run, "paused", { reason: "outside_allowed_origin" });
      }
      const clickStreak = run.steps
        .filter((step) => step.kind === "click" && !String(step.note || "").startsWith("not executed") && !String(step.note || "").startsWith("skipped"))
        .slice(-3);
      if (
        clickStreak.length === 3
        && clickStreak[0].action
        && clickStreak.every((step) => step.action === clickStreak[0].action)
        && clickStreak.some((step) => step.pageChanged === true)
      ) {
        return this.finish(run, "paused", {
          reason: "same_control_loop",
          detail: { action: clickStreak[0].action, steps: 3 },
          resumeHint: "The same control was clicked three times. Choose a different control (quantity, product, submit) or inspect the page.",
        });
      }

      const recent = run.steps.slice(-NO_PROGRESS_STEPS);
      if (
        recent.length === NO_PROGRESS_STEPS &&
        recent.every((step) => step.pageChanged === false && step.kind !== "wait")
      ) {
        // P11 — `no_page_change` est une HÉSITATION, pas un échec définitif.
        // Rien n'a été écrit de manière inconnue : les actions se sont exécutées
        // et la page n'a pas bougé. Le statut `blocked` (terminal) contredisait le
        // `resumeHint` fourni juste en dessous et rendait la reprise IMPOSSIBLE
        // (`resume` n'accepte que les runs `paused`) : l'utilisateur recevait un
        // conseil qu'il ne pouvait pas suivre.
        //
        // Le passage en `paused` rend la reprise possible — et, depuis P09, elle
        // exige un NOUVEAU contexte (hint), donc on ne rejoue pas la même chose à
        // l'identique en espérant un autre résultat.
        return this.finish(run, "paused", {
          reason: "no_page_change",
          detail: { steps: recent.map((step) => step.action) },
          resumeHint:
            "Three actions changed nothing on the page. Re-check the target (page_triage) or act manually, then run_goal {resume} with the new context.",
        });
      }
    }
  }
}
