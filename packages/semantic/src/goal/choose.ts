// choose() — ONE TypeSafe request per observation cycle.
//
// Port of browser-use/jev-ultrafast `model.py:choose`. The operation question
// and every operation-specific target head travel together, so the model makes
// both decisions in a single round trip and the code consumes only the head that
// matches the chosen operation (the other heads are speculative and free).
//
// Only the head selected by the operation is validated: an unused head may be
// malformed without blocking a safe action.

import type { JevClient } from "../jev/client.js";
import type { JevAnswer, JevQuestion, JevUsage } from "../types.js";
import {
  actionSpace,
  validateChoice,
  type ActionSpace,
  type ObservationAction,
} from "./action-space.js";
import {
  BLOCKED_LABEL,
  DONE_LABEL,
  NEXT_ACTION,
  OPERATION_LABELS,
  TARGET,
} from "./questions.js";

export interface HistoryEntry {
  action?: string;
  kind?: string;
  text?: string | null;
  page_changed?: boolean | null;
  [key: string]: unknown;
}

export interface ChoosePage {
  url?: string;
  title?: string;
  text?: string;
  w?: number;
  h?: number;
  marker?: string;
}

export interface ChooseInput {
  goal: string;
  page: ChoosePage;
  actions: ObservationAction[];
  history: HistoryEntry[];
  /** false → SELECT is excluded (option selection needs the evaluate gate). */
  evaluateAvailable: boolean;
}

export interface Decision {
  /** Executable action id in the observation (element id, or SCROLL_UP/WAIT). */
  choice: string;
  operation: string;
  target: string | null;
  confidence: number;
  /** Probability per executable action id. */
  probabilities: Record<string, number>;
  operationProbabilities: Record<string, number>;
  targetProbabilities: Record<string, number>;
  targetConfidence: number | null;
  model?: string;
  tookMs: number;
  cached: boolean;
  usage?: JevUsage;
  answers: Record<string, JevAnswer>;
  request: unknown;
}

export type ChooseResult =
  | { ok: true; decision: Decision; space: ActionSpace; warning?: string }
  | { ok: false; error: string; request?: unknown };

function summariseHistory(history: HistoryEntry[]): Array<Record<string, unknown>> {
  return history.slice(-10).map((entry) => ({
    action: entry.action,
    kind: entry.kind,
    text: entry.text,
    page_changed: entry.page_changed,
  }));
}

export async function choose(jev: JevClient, input: ChooseInput): Promise<ChooseResult> {
  const space = actionSpace(input.actions, {
    excludeOperations: input.evaluateAvailable ? [] : ["SELECT"],
  });
  // A page with no compatible control is NOT an error: it is a legitimate end
  // state (a submitted form landing on a JSON/text page, a fully-read article).
  // DONE and BLOCKED are always offered, so the model can close the goal. The
  // warning only tells the caller that the observation was empty.
  const warning =
    space.elements.length === 0
      ? "no_interactive_elements: the observation contains no compatible control; only DONE/BLOCKED/scroll/wait can be chosen. If the page should have controls, run page_triage (login wall, CAPTCHA, not-yet-rendered shell)."
      : undefined;

  const operations: Record<string, string> = {};
  for (const operation of Object.keys(space.targets)) {
    operations[operation] = OPERATION_LABELS[operation] ?? operation;
  }
  for (const [id, action] of Object.entries(space.controls)) {
    operations[id] = String(action.label ?? id);
  }
  operations.DONE = DONE_LABEL;
  operations.BLOCKED = BLOCKED_LABEL;

  const questions: Record<string, JevQuestion> = {
    operation: {
      type: "choice",
      criteria: operations,
      instructions: { goal: input.goal, rules: NEXT_ACTION },
    },
  };
  for (const [operation, candidates] of Object.entries(space.targets)) {
    questions[`${operation.toLowerCase()}_target`] = {
      type: "choice",
      criteria: Object.fromEntries(
        Object.entries(candidates).map(([index, action]) => [
          index,
          {
            element: `[${index}] ${action.label}`,
            current_value: action.current_value ?? action.value ?? "",
            ...Object.fromEntries(
              ["role", "checked", "selected", "expanded"]
                .filter((key) => key in action)
                .map((key) => [key, action[key]])
            ),
          },
        ])
      ),
      instructions: { goal: input.goal, operation, rules: [NEXT_ACTION, TARGET] },
    };
  }

  const request = {
    state: {
      page: { url: input.page.url, title: input.page.title, text: input.page.text },
      elements: space.elements,
      recent_actions: summariseHistory(input.history),
    },
    questions,
  };

  const result = await jev.ask(request.state, questions);
  if (!result.ok) {
    return { ok: false, error: `jev_unavailable: ${result.error}`, request };
  }

  const operationAnswer = validateChoice(result.answers.operation, Object.keys(operations));
  if (!operationAnswer.ok) {
    return { ok: false, error: `invalid_operation_answer: ${operationAnswer.error}`, request };
  }
  const operation = operationAnswer.answer.choice;

  let target: string | null = null;
  let targetProbabilities: Record<string, number> = {};
  let targetConfidence: number | null = null;
  let choice: string;
  let probabilities: Record<string, number>;

  const head = space.targets[operation];
  if (head) {
    const validated = validateChoice(
      result.answers[`${operation.toLowerCase()}_target`],
      Object.keys(head)
    );
    if (!validated.ok) {
      return { ok: false, error: `invalid_target_answer: ${validated.error}`, request };
    }
    target = validated.answer.choice;
    targetProbabilities = validated.answer.probabilities;
    targetConfidence = validated.answer.confidence;
    choice = head[target].id;
    probabilities = Object.fromEntries(
      Object.entries(head).map(([index, action]) => [action.id, targetProbabilities[index]])
    );
  } else {
    const control = space.controls[operation];
    choice = control ? control.id : operation;
    probabilities = { [choice]: operationAnswer.answer.probabilities[operation] };
  }

  return {
    ok: true,
    space,
    warning,
    decision: {
      choice,
      operation,
      target,
      confidence: operationAnswer.answer.confidence,
      probabilities,
      operationProbabilities: operationAnswer.answer.probabilities,
      targetProbabilities,
      targetConfidence,
      model: result.model,
      tookMs: result.tookMs,
      cached: result.cached,
      usage: result.usage,
      answers: result.answers,
      request,
    },
  };
}
