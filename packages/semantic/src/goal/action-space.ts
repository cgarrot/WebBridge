// Action space + strict answer validation for the goal loop.
//
// Port of browser-use/jev-ultrafast `model.py` (`action_space` +
// `validate_choice`). The action space is what makes the policy cheap: every
// observed element becomes ONE index, each operation gets its own target head
// containing only compatible elements, and pseudo-controls (scroll/wait)
// compete with elements in the operation question.

/** Minimal shape of one entry produced by the extension's `action_space` tool. */
export interface ObservationAction {
  id: string;
  node?: string;
  kind: string;
  role?: string;
  label: string;
  value?: unknown;
  current_value?: string;
  checked?: string;
  selected?: string;
  expanded?: string;
  rect?: { x: number; y: number; w: number; h: number };
  delta?: number;
  /**
   * P10 — cible de l'action, distincte de son libellé. Un libellé identique
   * (« Continuer », « Ouvrir ») peut pointer vers une destination différente :
   * c'est le vecteur d'une action périmée exécutée sur la mauvaise cible.
   */
  href?: string | null;
  form_action?: string | null;
  target?: string | null;
  target_guard?: string;
  [key: string]: unknown;
}

/**
 * P10 — empreinte de cible d'une action. Retourne `null` quand l'observation
 * n'expose aucune cible (les actions `scroll`/`wait`, ou une extension plus
 * ancienne) : dans ce cas il n'y a rien à comparer, et l'absence de cible n'est
 * PAS traitée comme un changement (sinon tout refuserait avec un ancien script).
 */
export function actionTargetGuard(action: ObservationAction | undefined): string | null {
  if (!action) return null;
  if (typeof action.target_guard === 'string' && action.target_guard.length > 0) return action.target_guard;
  const parts = [action.href, action.form_action, action.target];
  if (parts.every((part) => part === undefined || part === null)) return null;
  return parts.map((part) => (part === undefined || part === null ? '' : String(part))).join('\u0000');
}

export interface ActionSpaceElement {
  index: string;
  label: string;
  operations: string[];
  role?: string;
  value?: unknown;
  checked?: string;
  selected?: string;
  expanded?: string;
  options?: Array<{ index: string; label: string; value: string }>;
  [key: string]: unknown;
}

export interface ActionSpace {
  elements: ActionSpaceElement[];
  /** operation (CLICK | TYPE_TEXT | SELECT) → target index → executable action. */
  targets: Record<string, Record<string, ObservationAction>>;
  /** Pseudo-controls (scroll_down/scroll_up/wait) keyed by their uppercase id. */
  controls: Record<string, ObservationAction>;
}

const OPERATION_FOR_KIND: Record<string, string> = {
  click: "CLICK",
  fill: "TYPE_TEXT",
  select: "SELECT",
};

/**
 * Build the indexed element table and the per-operation target heads.
 *
 * Elements are deduplicated by node: one row per DOM node, listing every
 * operation it supports. Native dropdown options expand into their own targets
 * (`"<index>:<n>"`) so a select never needs a synthetic selector.
 *
 * @param actions Actions observed by the `action_space` tool.
 * @param options.excludeOperations Operations to drop entirely (e.g. SELECT
 *        when the daemon's `evaluate` gate is off and selection is impossible).
 */
export function actionSpace(
  actions: ObservationAction[],
  options: { excludeOperations?: string[] } = {}
): ActionSpace {
  const excluded = new Set(options.excludeOperations ?? []);
  const elements: ActionSpaceElement[] = [];
  const indices = new Map<string, string>();
  const targets: Record<string, Record<string, ObservationAction>> = {};
  const controls: Record<string, ObservationAction> = {};

  for (const action of actions ?? []) {
    const kind = String(action?.kind ?? "");
    const operation = OPERATION_FOR_KIND[kind];
    if (!operation || excluded.has(operation)) {
      if (!operation && action?.id) controls[String(action.id).toUpperCase()] = action;
      continue;
    }
    const node = String(action.node ?? "");
    if (!node) continue;
    let index = indices.get(node);
    if (!index) {
      index = String(elements.length + 1);
      indices.set(node, index);
      const element: ActionSpaceElement = { index, label: action.label.split(" → ")[0], operations: [] };
      for (const key of ["role", "value", "checked", "selected", "expanded"]) {
        if (key in action) element[key] = action[key];
      }
      if (kind === "select") {
        element.value = action.current_value ?? "";
        element.options = [];
      }
      elements.push(element);
    }
    const element = elements[Number(index) - 1];
    if (!element.operations.includes(operation)) element.operations.push(operation);
    const group = (targets[operation] ??= {});
    let target = index;
    if (kind === "select") {
      // A <select> only ever yields select actions, but be robust: an element
      // first seen through another kind still needs its options table.
      if (!Array.isArray(element.options)) {
        element.options = [];
        element.value = action.current_value ?? "";
      }
      const optionIndex = element.options.length + 1;
      target = `${index}:${optionIndex}`;
      element.options.push({ index: target, label: action.label, value: String(action.value ?? "") });
    }
    group[target] = action;
  }

  return { elements, targets, controls };
}

/** A validated Choice answer. */
export interface ChoiceAnswer {
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export type ValidationResult =
  | { ok: true; answer: ChoiceAnswer }
  | { ok: false; error: string };

/**
 * Validate a Choice answer against the exact option ids we sent.
 *
 * Port of `validate_choice`: the choice must be offered, the distribution must
 * cover every option exactly once, every number must be finite in [0,1], the
 * distribution must sum to ~1, and the reported choice must be the argmax. Any
 * deviation means "no action executed" — never a guessed action.
 */
export function validateChoice(raw: unknown, ids: Iterable<string>): ValidationResult {
  const expected = [...ids];
  if (!raw || typeof raw !== "object") return { ok: false, error: "answer is not an object" };
  const answer = raw as Partial<ChoiceAnswer>;
  const choice = answer.choice;
  const probabilities = answer.probabilities;
  const confidence = answer.confidence;

  if (typeof choice !== "string") return { ok: false, error: "answer has no choice" };
  if (expected.length > 0 && !expected.includes(choice)) {
    return { ok: false, error: `choice "${choice}" was not offered` };
  }
  if (!probabilities || typeof probabilities !== "object") {
    return { ok: false, error: "answer has no probabilities" };
  }
  const keys = Object.keys(probabilities);
  if (expected.length > 0 && (keys.length !== expected.length || expected.some((id) => !(id in probabilities)))) {
    return { ok: false, error: "probabilities do not match the offered options" };
  }
  const numbers = [...Object.values(probabilities), confidence];
  if (numbers.some((n) => typeof n !== "number" || !Number.isFinite(n))) {
    return { ok: false, error: "probabilities contain non-finite values" };
  }
  if ((numbers as number[]).some((n) => n < 0 || n > 1)) {
    return { ok: false, error: "probabilities outside [0,1]" };
  }
  const total = Object.values(probabilities).reduce<number>((sum, n) => sum + (n as number), 0);
  if (Math.abs(total - 1) >= 0.02) {
    return { ok: false, error: `probabilities sum to ${total.toFixed(4)} (expected ~1)` };
  }
  const max = Math.max(...(Object.values(probabilities) as number[]));
  if ((probabilities[choice] as number) < max - 1e-6) {
    return { ok: false, error: `choice "${choice}" is not the highest-probability option` };
  }
  return {
    ok: true,
    answer: { choice, probabilities: probabilities as Record<string, number>, confidence: confidence as number },
  };
}
