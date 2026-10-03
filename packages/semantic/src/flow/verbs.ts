// Verb implementations — each verb composes EXISTING WebBridge tools via the
// policy-aware `call` (evaluate is required for the native-setter/rect verbs;
// the runner fails fast with a clear message when it is disabled).

import type { JevClient } from "../jev/client.js";
import type { SemanticConfig, SideToolCall } from "../types.js";
import type { FlowRecipe, FlowStep, VerifyExpectation } from "./dsl.js";
import { resolveRef } from "./dsl.js";
import { writeScreenshot } from "./evidence.js";
import type { RunState } from "./evidence.js";

/** Thrown by verbs to request a pause (never a hard failure). */
export class VerbPause extends Error {
  constructor(
    public reason: string,
    public detail?: unknown,
    public resumeHint?: string
  ) {
    super(`pause:${reason}`);
  }
}

export interface VerbContext {
  call: SideToolCall;
  run: RunState;
  recipe: FlowRecipe;
  config: SemanticConfig;
  jev: JevClient;
  flowsDir: string;
  dryRun: boolean;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function tabArg(run: RunState): Record<string, unknown> {
  return run.tabId !== undefined ? { tabId: run.tabId } : {};
}

async function evalInPage(
  ctx: VerbContext,
  expression: string
): Promise<unknown> {
  const result = (await ctx.call("evaluate", {
    expression,
    returnByValue: true,
    ...tabArg(ctx.run),
  })) as { value?: unknown } | undefined;
  return result?.value;
}

// --- JS snippets (KDP-proven techniques from the kdp-publish skill) ----------

const js = {
  /**
   * Native-setter fill (the KDP-proven technique).
   *
   * `focus` is OFF by default and should stay off: measured on Chrome
   * (2026-09), calling `el.focus()` inside a CDP `Runtime.evaluate` while the
   * Chrome window is in the background drops the tab's `chrome.debugger`
   * attachment for good — every later attach fails with the misleading
   * "Cannot access a chrome-extension:// URL of different extension" until the
   * document is replaced. `blur()` alone and the `input`/`change` events are
   * safe. Sites that only enable their own widgets on focus can opt back in
   * with `{ "do": "fill_native", …, "focus": true }`.
   */
  fillNative: (selector: string, value: string, focus = false) => `
(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return { found: false };
  ${focus ? "el.focus();" : ""}
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter && "value" in el) {
    setter.call(el, "");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    setter.call(el, ${JSON.stringify(value)});
  } else {
    el.textContent = ${JSON.stringify(value)};
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  ${focus ? "el.blur();" : ""}
  return { found: true };
})()`,

  elementCenter: (selector: string) => `
(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return null;
  el.scrollIntoView({ block: "center", inline: "nearest" });
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) };
})()`,

  clickJs: (selector: string) => `
(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return { found: false };
  el.click();
  return { found: true };
})()`,

  selectNative: (selector: string, value: string) => `
(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return { found: false };
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
  if (setter) setter.call(el, ${JSON.stringify(value)});
  else el.value = ${JSON.stringify(value)};
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { found: true };
})()`,

  ckeditor: (globalExpr: string, html: string) => `
(() => {
  try {
    const ed = ${globalExpr};
    if (!ed) return { ok: false, error: "editor not found" };
    ed.setData(${JSON.stringify(html)});
    ed.updateElement?.();
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e) }; }
})()`,

  autocompleteOption: (needle: string) => `
(() => {
  const needle = ${JSON.stringify(needle.toLowerCase())};
  const candidates = document.querySelectorAll('li,[role="option"],[role="menuitem"],.ui-menu-item,[data-index],ul[role="listbox"] *');
  let match = null;
  for (const el of candidates) {
    const text = (el.textContent || "").trim();
    if (!text || text.length > 120) continue;
    if (text.toLowerCase().includes(needle) && el.offsetParent !== null) { match = el; break; }
    if (!match && text.toLowerCase().includes(needle)) match = el;
  }
  if (!match) return null;
  match.scrollIntoView({ block: "center" });
  const r = match.getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
})()`,

  retrigger: (selector: string, events: string[]) => `
(() => {
  const els = document.querySelectorAll(${JSON.stringify(selector)});
  let n = 0;
  for (const el of els) {
    for (const type of ${JSON.stringify(events)}) el.dispatchEvent(new Event(type, { bubbles: true }));
    n++;
  }
  return { triggered: n };
})()`,
};

async function realClick(ctx: VerbContext, selector: string): Promise<string> {
  const center = (await evalInPage(ctx, js.elementCenter(selector))) as
    | { x: number; y: number }
    | null;
  if (!center) {
    throw new VerbPause(
      "element_not_found",
      { selector },
      `The selector is not on the page (yet). Inspect the tab (get_tab_info / extract_text), adjust the recipe, then run_flow {resume}.`
    );
  }
  await ctx.call("click", { x: center.x, y: center.y, ...tabArg(ctx.run) });
  return `clicked ${selector} @ ${center.x},${center.y}`;
}

function dangerous(ctx: VerbContext, selector: string): boolean {
  return (ctx.recipe.dangerous ?? []).some((d) =>
    d ? selector.includes(d) : false
  );
}

// --- Verify ------------------------------------------------------------------

async function buildVerifyState(ctx: VerbContext) {
  let extracted = (await ctx.call("extract_text", {
    selectors: ["main", "article"],
    maxChars: 3000,
    ...tabArg(ctx.run),
  })) as { url?: string; title?: string; text?: string; chars?: number };
  if ((extracted?.chars ?? 0) < 40) {
    extracted = (await ctx.call("extract_text", {
      maxChars: 3000,
      ...tabArg(ctx.run),
    })) as typeof extracted;
  }
  return {
    page: { url: extracted?.url, title: extracted?.title },
    text: extracted?.text ?? "",
  };
}

interface VerifyOutcome {
  ok: boolean;
  note?: string;
}

export async function verifyStep(
  step: FlowStep,
  ctx: VerbContext
): Promise<VerifyOutcome> {
  const expect = step.expect as Record<string, VerifyExpectation>;
  const state = await buildVerifyState(ctx);
  const questions: Record<string, unknown> = {};
  for (const [name, exp] of Object.entries(expect)) {
    questions[name] = {
      type: exp.type,
      instructions: exp.instructions,
      ...(exp.criteria !== undefined ? { criteria: exp.criteria } : {}),
    };
  }

  const retryDelayMs =
    typeof step.retryDelayMs === "number" ? step.retryDelayMs : 1500;

  // Network-level resilience: one retry for transient ask failures (timeout,
  // network) before pausing. API 4xx errors surface immediately (deterministic).
  const askWithRetry = async () => {
    let lastAskError = "jev_unavailable";
    for (let askAttempt = 1; askAttempt <= 2; askAttempt++) {
      const result = await ctx.jev.ask(state, questions as never);
      if (result.ok) return result;
      lastAskError = result.error;
      if (result.error.startsWith("api_4")) break; // client error: no retry
      if (askAttempt === 1) await sleep(retryDelayMs);
    }
    throw new VerbPause(
      "jev_unavailable",
      { error: lastAskError },
      "Jev could not verify this checkpoint after retries. Check /health semantic block; resume when available."
    );
  };

  for (let attempt = 1; attempt <= 2; attempt++) {
    const result = await askWithRetry();

    const failures: Record<string, unknown> = {};
    const lowConfidence: Record<string, unknown> = {};
    for (const [name, exp] of Object.entries(expect)) {
      const answer = result.answers[name];
      const minConfidence = exp.minConfidence ?? ctx.config.jevMinConfidence;
      if (
        answer?.confidence !== undefined &&
        answer.confidence < minConfidence
      ) {
        lowConfidence[name] = { answer, minConfidence };
        continue;
      }
      if (exp.type === "noul") {
        const v = answer?.noul ?? 0;
        const threshold = exp.threshold ?? 0.7;
        const pass = exp.expectFalse ? v < 1 - threshold : v >= threshold;
        if (!pass) {
          failures[name] = { noul: v, threshold, expectFalse: !!exp.expectFalse, confidence: answer?.confidence };
        }
      } else {
        // score/choice: presence of a confident answer passes
        if (answer?.confidence === undefined || answer.confidence < minConfidence) {
          failures[name] = { answer };
        }
      }
    }

    if (Object.keys(lowConfidence).length > 0) {
      throw new VerbPause(
        "low_confidence",
        { lowConfidence },
        "Jev is unsure about this checkpoint. Inspect the tab (screenshot/extract_text), fix the page state if needed, then run_flow {resume}."
      );
    }
    if (Object.keys(failures).length === 0) {
      return { ok: true, note: `verified ${Object.keys(expect).join(", ")}` };
    }
    if (attempt === 1) {
      await sleep(retryDelayMs);
    } else {
      throw new VerbPause(
        "verify_failed",
        { failures, state: { url: state.page.url, title: state.page.title } },
        "The checkpoint did not pass twice. Inspect the tab, correct the mismatch (manually or with tools), then run_flow {resume} to re-verify."
      );
    }
  }
  return { ok: false }; // unreachable
}

// --- Dispatch ----------------------------------------------------------------

export async function execVerb(
  step: FlowStep,
  ctx: VerbContext
): Promise<VerifyOutcome> {
  const run = ctx.run;
  // Value-ref failures are fixable (pass params on resume) → pause, not fail.
  const P = (value: string) => {
    try {
      return resolveRef(value, run.params, run.vars);
    } catch (err) {
      throw new VerbPause(
        "value_ref_failed",
        { ref: value, error: (err as Error).message },
        `Provide the missing value via run_flow {resume:"${run.runId}", params:{...}} and it will retry.`
      );
    }
  };

  switch (step.do) {
    case "navigate": {
      const url = P(step.url as string);
      const nav = (await ctx.call("navigate", {
        url,
        waitUntil: "load",
        newTab: true, // reuse-or-create the session tab
      })) as { tabId?: number } | undefined;
      if (nav?.tabId !== undefined && run.tabId === undefined) {
        run.tabId = nav.tabId;
      }
      // Consistency guard against a pre-existing navigate race: a reused tab
      // can report loaded:true for its OLD page while the update is still in
      // flight. Poll until the tab URL actually reaches the target host.
      let host = "";
      try {
        host = new URL(url).hostname;
      } catch {
        host = "";
      }
      if (host) {
        for (let probe = 0; probe < 4; probe++) {
          const info = (await ctx.call("get_tab_info", {
            ...(run.tabId !== undefined ? { tabId: run.tabId } : {}),
          })) as { url?: string } | undefined;
          const current = info?.url ?? "";
          let matches = false;
          try {
            matches = new URL(current).hostname === host;
          } catch {
            matches = false;
          }
          if (matches) break;
          if (probe === 3) {
            // Self-heal: the reused tab ignored the update (stale-SW navigate
            // bug). Escape the reuse path entirely with a brand-new tab.
            try {
              const retry = (await ctx.call("navigate", {
                url,
                waitUntil: "load",
                newTab: true,
                forceNewTab: true,
              })) as { tabId?: number } | undefined;
              if (retry?.tabId !== undefined) run.tabId = retry.tabId;
              const info2 = (await ctx.call("get_tab_info", {
                ...(run.tabId !== undefined ? { tabId: run.tabId } : {}),
              })) as { url?: string } | undefined;
              let healed = false;
              try {
                healed = new URL(info2?.url ?? "").hostname === host;
              } catch {
                healed = false;
              }
              return {
                ok: true,
                note: healed
                  ? `navigated ${url} in a fresh tab ${run.tabId} (reused tab was stuck on ${current || "?"})`
                  : `navigated ${url} but tab still shows ${info2?.url ?? "?"} (verify will catch it)`,
              };
            } catch {
              return {
                ok: true,
                note: `navigated ${url} but tab still shows ${current || "?"} (verify will catch it)`,
              };
            }
          }
          await sleep(800);
        }
      }
      return { ok: true, note: `navigated ${url} (tab ${nav?.tabId ?? "?"})` };
    }

    case "fill_native": {
      const outcome = (await evalInPage(
        ctx,
        js.fillNative(step.selector as string, P(step.value as string), step.focus === true)
      )) as { found?: boolean } | undefined;
      if (!outcome?.found) {
        throw new VerbPause(
          "element_not_found",
          { selector: step.selector },
          "The fill target is missing. Check the page state, then resume."
        );
      }
      return { ok: true, note: `filled ${step.selector}` };
    }

    case "real_click": {
      const selector = step.selector as string;
      if (ctx.dryRun && dangerous(ctx, selector)) {
        return { ok: true, note: `DRY-RUN: skipped dangerous selector ${selector}` };
      }
      return { ok: true, note: await realClick(ctx, selector) };
    }

    case "click_js": {
      const selector = step.selector as string;
      if (ctx.dryRun && dangerous(ctx, selector)) {
        return { ok: true, note: `DRY-RUN: skipped dangerous selector ${selector}` };
      }
      const outcome = (await evalInPage(ctx, js.clickJs(selector))) as
        | { found?: boolean }
        | undefined;
      if (!outcome?.found) {
        throw new VerbPause(
          "element_not_found",
          { selector },
          "The click target is missing. Check the page state, then resume."
        );
      }
      return { ok: true, note: `js-clicked ${selector}` };
    }

    case "find_click": {
      const found = (await ctx.call("find_element", {
        description: step.description as string,
        ...tabArg(run),
      })) as Record<string, unknown> | undefined;
      if (!found || found.ok !== true) {
        throw new VerbPause(
          "element_not_found",
          { find_element: found },
          "find_element failed. get_visible_dom/screenshot the tab, then resume with a fixed recipe or act manually."
        );
      }
      if (found.fallback === true || !found.nodeId) {
        throw new VerbPause(
          "element_not_resolved",
          { found },
          "Jev could not resolve the described element. Use the returned candidates, click manually, then resume."
        );
      }
      const selector = `[data-wb-id="${found.nodeId}"]`;
      if (ctx.dryRun && dangerous(ctx, selector)) {
        return { ok: true, note: `DRY-RUN: skipped dangerous target ${selector}` };
      }
      return {
        ok: true,
        note: `${await realClick(ctx, selector)} (matched: ${JSON.stringify(found.matched ?? {})})`,
      };
    }

    case "autocomplete": {
      const selector = step.selector as string;
      const text = P(step.text as string);
      const fill = (await evalInPage(ctx, js.fillNative(selector, text))) as
        | { found?: boolean }
        | undefined;
      if (!fill?.found) {
        throw new VerbPause("element_not_found", { selector }, "Autocomplete input missing; check page then resume.");
      }
      await sleep(400); // dropdown render
      const needle = P((step.optionIncludes as string) ?? text);
      const center = (await evalInPage(ctx, js.autocompleteOption(needle))) as
        | { x: number; y: number }
        | null;
      if (!center) {
        throw new VerbPause(
          "option_not_found",
          { needle },
          "The dropdown option is not visible. Screenshot the tab, then resume."
        );
      }
      await ctx.call("click", { x: center.x, y: center.y, ...tabArg(run) });
      return { ok: true, note: `autocomplete "${text}" → "${needle}"` };
    }

    case "ckeditor": {
      const outcome = (await evalInPage(
        ctx,
        js.ckeditor(P(step.global as string), P(step.html as string))
      )) as { ok?: boolean; error?: string } | undefined;
      if (!outcome?.ok) {
        throw new VerbPause(
          "ckeditor_failed",
          { outcome },
          "CKEditor global not ready. Verify the editor instance name, then resume."
        );
      }
      return { ok: true, note: `ckeditor ${step.global} set` };
    }

    case "select_native": {
      const outcome = (await evalInPage(
        ctx,
        js.selectNative(step.selector as string, P(step.value as string))
      )) as { found?: boolean } | undefined;
      if (!outcome?.found) {
        throw new VerbPause("element_not_found", { selector: step.selector }, "Select missing; check page then resume.");
      }
      return { ok: true, note: `selected ${step.selector} = ${step.value}` };
    }

    case "upload": {
      const files = (step.files as string[]).map((f) => P(f));
      await ctx.call("upload", {
        selector: step.selector as string,
        filePaths: files,
        ...tabArg(run),
      });
      return { ok: true, note: `uploaded ${files.length} file(s) to ${step.selector}` };
    }

    case "wait_text": {
      const includes = P(step.includes as string);
      const timeoutMs =
        typeof step.timeoutMs === "number" ? step.timeoutMs : 30000;
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        const snippets = (await ctx.call("extract_text", {
          includes,
          mode: "snippets",
          maxMatches: 1,
          maxChars: 120,
          ...tabArg(run),
        })) as { snippets?: unknown[]; totalMatches?: number };
        const found =
          (snippets?.totalMatches ?? 0) > 0 ||
          (Array.isArray(snippets?.snippets) && snippets.snippets.length > 0);
        if (found) return { ok: true, note: `text "${includes}" present` };
        await sleep(1000);
      }
      throw new VerbPause(
        "wait_text_timeout",
        { includes, timeoutMs },
        "The expected text never appeared. Inspect the tab (screenshot), then resume or fix the recipe."
      );
    }

    case "retrigger": {
      const events = Array.isArray(step.events)
        ? (step.events as string[])
        : ["input", "change"];
      const outcome = (await evalInPage(
        ctx,
        js.retrigger(step.selector as string, events)
      )) as { triggered?: number } | undefined;
      return { ok: true, note: `retriggered ${outcome?.triggered ?? 0} element(s)` };
    }

    case "verify":
      return verifyStep(step, ctx);

    case "screenshot": {
      const shot = (await ctx.call("screenshot", { ...tabArg(run) })) as
        | { data?: string }
        | undefined;
      if (shot?.data) {
        const rel = writeScreenshot(
          ctx.flowsDir,
          run.runId,
          run.stepIndex,
          typeof step.label === "string" ? step.label : undefined,
          shot.data
        );
        run.evidence.push(rel);
        return { ok: true, note: `screenshot ${rel}` };
      }
      return { ok: true, note: "screenshot returned no data (skipped)" };
    }

    case "gate": {
      const id = step.id as string;
      if (!step.requireApproval) {
        return { ok: true, note: `gate ${id} auto-passed (no approval required)` };
      }
      if (ctx.dryRun) {
        throw new VerbPause(
          "dry_run_stop",
          { gate: id },
          `Dry-run stopped before gate "${id}" as designed. Re-run with dryRun:false (plus approvals) to go further.`
        );
      }
      // Params gate FIRST: approval alone must never bypass required params.
      const missing = (Array.isArray(step.requiresParams) ? (step.requiresParams as string[]) : []).filter(
        (param) => run.params?.[param] !== true
      );
      if (missing.length > 0) {
        throw new VerbPause(
          "missing_param",
          { gate: id, missing },
          `Pass {params:{${missing.map((m) => `${m}:true`).join(", ")}}} in run_flow {resume} to satisfy gate "${id}".`
        );
      }
      if (run.approved.includes(id)) {
        return { ok: true, note: `gate ${id} passed (approved)` };
      }
      throw new VerbPause(
        "approval_required",
        { gate: id },
        `Approve with run_flow {resume:"${run.runId}", approve:["${id}"]}. This approval is one-shot and logged.`
      );
    }

    case "capture": {
      const info = (await ctx.call("get_tab_info", { ...tabArg(run) })) as
        | { url?: string }
        | undefined;
      const url = info?.url ?? "";
      const match = new RegExp(step.pattern as string).exec(url);
      if (!match) {
        throw new VerbPause(
          "capture_failed",
          { pattern: step.pattern, url },
          "The URL does not match the capture pattern. Navigate/verify the tab, then resume."
        );
      }
      run.vars[step.to as string] = match[1] ?? match[0];
      return { ok: true, note: `captured ${step.to}=${run.vars[step.to as string]}` };
    }

    case "subflow":
      throw new VerbPause(
        "not_implemented",
        { verb: "subflow" },
        "Subflows land in a later PR; split the recipe for now."
      );

    default:
      throw new Error(`unknown verb ${(step as { do: string }).do}`);
  }
}
