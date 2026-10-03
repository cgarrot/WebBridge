// Flow DSL — recipe schema + validation (Layer 2, PR 4).
//
// A recipe is a deterministic step sequence executed by the daemon-side flow
// runner. Code owns the control flow; Jev only verifies checkpoints (TypeSafe
// "AI-powered software" pattern). All mutating verbs are implemented as
// compositions of EXISTING WebBridge tools via the policy-aware `call` — no
// CDP bypass, no extension changes.
//
// Value refs: string fields starting with `$` resolve from run params via
// dot path ("$meta.title" → params.meta.title). `$var.xxx` resolves captured
// runtime vars (see the `capture` verb).

export interface VerifyExpectation {
  type: "noul" | "score" | "choice";
  instructions: string | Record<string, unknown>;
  criteria?: unknown;
  /** Pass when the flag is ABSENT (noul below the inverse threshold). Default false. */
  expectFalse?: boolean;
  /** noul ≥ threshold passes (default 0.7); with expectFalse, noul < 1-threshold passes. */
  threshold?: number;
  /** Below this confidence the verify PAUSES (low_confidence) instead of failing. Default 0.5. */
  minConfidence?: number;
}

export type FlowStep = {
  do: "navigate" | "fill_native" | "real_click" | "click_js" | "find_click" |
      "autocomplete" | "ckeditor" | "select_native" | "upload" | "wait_text" |
      "retrigger" | "verify" | "screenshot" | "gate" | "capture" | "subflow";
  desc?: string;
  [key: string]: unknown;
};

export interface FlowRecipe {
  id: string;
  title?: string;
  site?: string;
  /** Selector substrings that dry-run must never click. */
  dangerous?: string[];
  steps: FlowStep[];
}

// Mirrors MAX_FLOW_STEPS in @webbridge/shared (kept local: this package has no
// runtime deps by design).
export const MAX_FLOW_STEPS = 200;

export const VERBS_REQUIRING_EVALUATE = new Set([
  "fill_native",
  "real_click",
  "click_js",
  "find_click", // resolves to a real_click on [data-wb-id]
  "autocomplete",
  "ckeditor",
  "select_native",
  "retrigger",
]);

const REQUIRED_FIELDS: Record<string, string[]> = {
  navigate: ["url"],
  fill_native: ["selector", "value"],
  real_click: ["selector"],
  click_js: ["selector"],
  find_click: ["description"],
  autocomplete: ["selector", "text"],
  ckeditor: ["global", "html"],
  select_native: ["selector", "value"],
  upload: ["selector", "files"],
  wait_text: ["includes"],
  retrigger: ["selector"],
  verify: [],
  screenshot: [],
  gate: ["id"],
  capture: ["pattern", "to"],
  subflow: ["flow"],
};

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0;

export function validateRecipe(
  recipe: unknown
): { ok: true; recipe: FlowRecipe } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!recipe || typeof recipe !== "object") {
    return { ok: false, errors: ["recipe must be an object"] };
  }
  const r = recipe as Partial<FlowRecipe>;
  if (!isNonEmptyString(r.id)) errors.push("id is required");
  if (!Array.isArray(r.steps) || r.steps.length === 0) {
    errors.push("steps must be a non-empty array");
  } else {
    if (r.steps.length > MAX_FLOW_STEPS) {
      errors.push(`steps exceed MAX_FLOW_STEPS (${MAX_FLOW_STEPS})`);
    }
    r.steps.forEach((step, i) => {
      const s = step as FlowStep;
      if (!s || typeof s !== "object" || !isNonEmptyString(s.do)) {
        errors.push(`steps[${i}]: missing "do" verb`);
        return;
      }
      if (!(s.do in REQUIRED_FIELDS)) {
        errors.push(`steps[${i}]: unknown verb "${s.do}"`);
        return;
      }
      for (const field of REQUIRED_FIELDS[s.do]) {
        const v = s[field];
        const valid =
          field === "files"
            ? Array.isArray(v) && v.every(isNonEmptyString) && v.length > 0
            : isNonEmptyString(v);
        if (!valid) errors.push(`steps[${i}] (${s.do}): "${field}" is required`);
      }
      if (s.do === "verify") {
        const expect = s.expect as Record<string, unknown> | undefined;
        if (!expect || typeof expect !== "object" || Object.keys(expect).length === 0) {
          errors.push(`steps[${i}] (verify): "expect" must be a non-empty object`);
        } else {
          for (const [name, exp] of Object.entries(expect)) {
            const e = exp as Partial<VerifyExpectation>;
            if (!e || (e.type !== "noul" && e.type !== "score" && e.type !== "choice")) {
              errors.push(`steps[${i}] (verify): expect.${name}.type must be noul|score|choice`);
            } else if (!e.instructions) {
              errors.push(`steps[${i}] (verify): expect.${name}.instructions is required`);
            }
          }
        }
      }
    });
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, recipe: r as FlowRecipe };
}

/** Resolve `$dot.path` value refs from params and captured vars. Throws on missing. */
export function resolveRef(
  value: string,
  params: Record<string, unknown>,
  vars: Record<string, string>
): string {
  if (!value.startsWith("$")) return value;
  const path = value.slice(1);
  const root = path.split(".")[0];
  const source = root === "var" || root === "vars" ? vars : params;
  const segments = root === "var" || root === "vars" ? path.split(".").slice(1) : path.split(".");
  let current: unknown = source;
  for (const segment of segments) {
    if (current === null || current === undefined || typeof current !== "object") {
      throw new Error(`value ref "${value}" cannot be resolved (missing "${segment}")`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  if (current === undefined || current === null) {
    throw new Error(`value ref "${value}" resolved to null/undefined`);
  }
  return String(current);
}
