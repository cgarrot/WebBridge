import type {
  GetVisibleDomArgs,
  ClickElementArgs,
  TypeElementArgs,
  HighlightArgs,
  VisibleDomContext,
  VisibleDomSemanticContext,
  VisibleDomBehaviorContext,
} from "@webbridge/shared";
import { nativeTextEditExpression,nativeCommitClickExpression } from '@webbridge/shared';
import { BaseTool, type ToolContext } from "./base.js";
import { resolveTabId } from "../../cdp/session.js";
import { moveCursor, cursorClickEffect, highlightRect } from "../../cdp/cursor.js";

import { GET_VISIBLE_DOM_SCRIPT, GET_VISIBLE_DOM_CONTEXT_SCRIPT, GET_VISIBLE_DOM_SEMANTIC_SCRIPT, GET_VISIBLE_DOM_BEHAVIOR_SCRIPT } from './visible-dom-script.js';

// ── J1 SET-junction (copies-phase proposal, NOT applied) ────────────────
// Per-Document occurrence registry, page-INACCESSIBLE by construction: keyed
// by (tabId, loaderId, backendNodeId) — CDP-only identities resolved
// extension-side, never trusted from evaluated MAIN-world output. Lives in
// the background context (long-lived), NEVER a per-call local recreated
// each executeScript. H02 CAVEAT (live-validation gate): DOM-domain calls
// detached the debugger once (focus path) — getDocument/querySelector below
// must be live-proven non-detaching before apply; on detachment, fail with
// an explicit error (refuse), never silently.
const occurrenceRegistries = new Map<string, { incarnation: string; occ: Map<number, string>; counter: number }>();
let incarnationSeq = 0;
async function documentIncarnation(ctx: ToolContext, tabId: number): Promise<{ loaderId: string; incarnation: string }> {
  const tree = await ctx.cdp.send<{ frameTree: { frame: { id: string; loaderId: string } } }>(
    tabId, 'Page.getFrameTree', {});
  const loaderId = tree.frameTree.frame.loaderId; // rotates on every navigation commit incl. same-URL reload
  const key = `${tabId}::${loaderId}`;
  let r = occurrenceRegistries.get(key);
  if (!r) { r = { incarnation: `doc-inc-${++incarnationSeq}`, occ: new Map(), counter: 0 }; occurrenceRegistries.set(key, r); }
  return { loaderId, incarnation: r.incarnation };
}
async function backendOccurrence(ctx: ToolContext, tabId: number, loaderId: string, incarnation: string, backendNodeId: number): Promise<string> {
  const key = `${tabId}::${loaderId}`;
  const r = occurrenceRegistries.get(key);
  if (!r || r.incarnation !== incarnation) throw new Error('junction_incarnation_rotated');
  let occurrence = r.occ.get(backendNodeId);
  if (occurrence === undefined) { occurrence = `occ-${++r.counter}`; r.occ.set(backendNodeId, occurrence); }
  return occurrence;
}
/** Post-read recovery FROM THE LIVE NODE (never echo): resolve backendNodeId
 *  extension-side, then registry. Unknown => undefined (explicit unknown). */
export async function resolveObservedPhysical(ctx: ToolContext, tabId: number, selector: string): Promise<{ incarnation: string; occurrence: string } | undefined> {
  const { loaderId, incarnation } = await documentIncarnation(ctx, tabId);
  const doc = await ctx.cdp.send<{ root: { nodeId: number } }>(tabId, 'DOM.getDocument', { depth: 0 });
  const found = await ctx.cdp.send<{ nodeId: number }>(tabId, 'DOM.querySelector', { nodeId: doc.root.nodeId, selector });
  if (!found.nodeId) return undefined;
  const described = await ctx.cdp.send<{ node: { backendNodeId: number } }>(tabId, 'DOM.describeNode', { nodeId: found.nodeId });
  const key = `${tabId}::${loaderId}`;
  const occurrence = occurrenceRegistries.get(key)?.occ.get(described.node.backendNodeId);
  return occurrence === undefined ? undefined : { incarnation, occurrence };
}
// ── end J1 ───────────────────────────────────────────────────────────────

export class GetVisibleDomTool extends BaseTool {
  readonly name = "get_visible_dom" as const;
  readonly description = "Get visible interactable DOM elements with node IDs";

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
    const { tabId: rawTabId, includeContext, includeSemanticContext, includeBehaviorContext } = args as unknown as GetVisibleDomArgs;
    if (includeContext !== undefined && typeof includeContext !== 'boolean') throw new Error('invalid includeContext');
    if (includeSemanticContext !== undefined && typeof includeSemanticContext !== 'boolean'
      || includeSemanticContext && includeContext !== true) throw new Error('invalid includeSemanticContext');
    if(includeBehaviorContext!==undefined&&typeof includeBehaviorContext!=='boolean'||includeBehaviorContext&&(includeContext!==true||includeSemanticContext!==true))throw Error('invalid includeBehaviorContext');
    const tabId = await resolveTabId(rawTabId);

    const result = await ctx.cdp.send<{
      result: { value: unknown };
    }>(tabId, "Runtime.evaluate", {
      expression: includeBehaviorContext ? GET_VISIBLE_DOM_BEHAVIOR_SCRIPT : includeSemanticContext ? GET_VISIBLE_DOM_SEMANTIC_SCRIPT : includeContext ? GET_VISIBLE_DOM_CONTEXT_SCRIPT : GET_VISIBLE_DOM_SCRIPT,
      returnByValue: true,
      awaitPromise: false,
    });

    if (includeContext) {
      const observation = result.result.value as Omit<VisibleDomContext | VisibleDomSemanticContext | VisibleDomBehaviorContext, 'tabId'> | undefined;
      if (observation?.schema !== (includeBehaviorContext?'visible-dom/4.0':includeSemanticContext ? 'visible-dom/3.0' : 'visible-dom/2.0')) throw new Error('native DOM context unavailable');
      // J1: attach registry metadata (host-internal, never alias-deduced).
      // Per-node backend join via DOM.querySelector + DOM.describeNode
      // (upload.ts precedent). H02 LIVE-GATE: DOM-domain calls detached the
      // debugger once — this join must be live-proven non-detaching before
      // apply; ANY detachment throws explicitly (refuse), never silently.
      // Nodes unresolvable here carry NO occurrence (downstream refuses rather
      // than defaulting). wb-id alias re-minting stays untouched/separate.
      const { loaderId, incarnation } = await documentIncarnation(ctx, tabId);
      const doc = await ctx.cdp.send<{ root: { nodeId: number } }>(tabId, 'DOM.getDocument', { depth: 0 });
      const nodes: any[] = Array.isArray((observation as any).nodes) ? (observation as any).nodes : [];
      for (const n of nodes) {
        if (typeof n?.id !== 'string' || !n.id) continue;
        // CDP errors propagate (a poisoned session must abort the pass — fail
        // loud); only a vanished node (falsy nodeId) skips silently.
        const found = await ctx.cdp.send<{ nodeId: number }>(tabId, 'DOM.querySelector',
          { nodeId: doc.root.nodeId, selector: `[data-wb-id="${n.id}"]` });
        if (!found.nodeId) continue;
        const described = await ctx.cdp.send<{ node: { backendNodeId: number } }>(
          tabId, 'DOM.describeNode', { nodeId: found.nodeId });
        (n as any).occurrence_incarnation = incarnation;
        (n as any).occurrence = await backendOccurrence(ctx, tabId, loaderId, incarnation, described.node.backendNodeId);
      }
      return { ...observation, tabId, occurrence_incarnation: incarnation };
    }
    return result.result.value;
  }
}

/** J1b resolve_observed_physical tool (copies-phase proposal, NOT applied).
 *  Exposes resolveObservedPhysical over the tool boundary so the DAEMON can
 *  recover post-read identity WITHOUT trusting page-visible output. Args:
 *  { tabId, selector } (selector = data-wb-id query, e.g. '[data-wb-id="n7"]').
 *  Returns { incarnation, occurrence } or throws (unknown/detached => refuse
 *  downstream, never silent). Registered in index.ts; named in shared/tools.ts.
 *  Daemon contract: call("resolve_observed_physical", { tabId, selector }). */
export class ResolveObservedPhysicalTool extends BaseTool {
  readonly name = "resolve_observed_physical" as const;
  readonly description = "Resolve the registry physical identity of the live DOM node (never echo)";
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
    const { tabId: rawTabId, selector } = args as unknown as { tabId?: number; selector?: unknown };
    if (typeof selector !== 'string' || !selector) throw new Error('resolve_observed_physical: selector is required');
    const tabId = await resolveTabId(rawTabId);
    const recovered = await resolveObservedPhysical(ctx, tabId, selector);
    if (!recovered) throw new Error('resolve_observed_physical: unknown element (refuse downstream)');
    return recovered;
  }
}

const FIND_ELEMENT_SCRIPT = (nodeId: string) => `
(() => {
  const el = document.querySelector('[data-wb-id="${nodeId}"]');
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  return {
    found: true,
    centerX: Math.round(rect.x + rect.width / 2),
    centerY: Math.round(rect.y + rect.height / 2),
    rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
    tag: el.tagName.toLowerCase(),
    text: (el.textContent || '').trim().substring(0, 80)
  };
})()
`;

export class ClickElementTool extends BaseTool {
  readonly name = "click_element" as const;
  readonly description = "Click a DOM element by its node ID (from get_visible_dom)";

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
    const { nodeId, tabId: rawTabId,commitBinding,deadlineAtMs,operationRef } = args as unknown as ClickElementArgs;
    if (!nodeId) throw new Error("click_element: nodeId is required");

    const tabId = await resolveTabId(rawTabId);

    if(commitBinding!==undefined){
      const result=await ctx.cdp.send<{result:{value:any};exceptionDetails?:unknown}>(tabId,'Runtime.evaluate',{
        expression:nativeCommitClickExpression(nodeId,commitBinding,deadlineAtMs as number,operationRef),returnByValue:true,
      });
      if(result.exceptionDetails||typeof result.result?.value?.dispatched!=='boolean')throw Error('native commit effect unknown');
      const outcome=result.result.value;
      return {tabId,nodeId,...outcome,status:outcome.effect_unknown?'effect_unknown':outcome.dispatched?'executed':'not_executed',activation:'guarded_programmatic_click'};
    }

    const result = await ctx.cdp.send<{ result: { value: any } }>(
      tabId, "Runtime.evaluate",
      { expression: FIND_ELEMENT_SCRIPT(nodeId), returnByValue: true }
    );

    const info = result.result.value;
    if (!info) throw new Error(`click_element: node "${nodeId}" not found. Run get_visible_dom first.`);

    await moveCursor(tabId, info.centerX, info.centerY, true);
    await cursorClickEffect(tabId, info.centerX, info.centerY);

    await ctx.cdp.send(tabId, "Input.dispatchMouseEvent", {
      type: "mousePressed", x: info.centerX, y: info.centerY,
      button: "left", clickCount: 1, buttons: 1,
    });
    await ctx.cdp.send(tabId, "Input.dispatchMouseEvent", {
      type: "mouseReleased", x: info.centerX, y: info.centerY,
      button: "left", clickCount: 1,
    });

    return { tabId, nodeId, tag: info.tag, text: info.text, x: info.centerX, y: info.centerY };
  }
}

export class TypeElementTool extends BaseTool {
  readonly name = "type_element" as const;
  readonly description = "Type text into a DOM element by node ID (focuses via CDP, then inserts text)";

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
    const {
      nodeId,
      text,
      tabId: rawTabId,
      clearFirst = true,
      focus = true,
      binding,
    } = args as unknown as TypeElementArgs;
    if (!nodeId) throw new Error("type_element: nodeId is required");
    if (text === undefined) throw new Error("type_element: text is required");

    const tabId = await resolveTabId(rawTabId);

    if (binding !== undefined) {
      if (clearFirst !== true) throw new Error('native text binding requires complete replacement');
      const result = await ctx.cdp.send<{ result: { value: any }; exceptionDetails?: unknown }>(tabId,'Runtime.evaluate',{
        expression: nativeTextEditExpression(nodeId,text,binding),returnByValue:true,
      });
      if (result.exceptionDetails || typeof result.result?.value?.written !== 'boolean') throw new Error('native text effect unknown');
      const outcome=result.result.value;
      return { tabId,nodeId,...outcome,typed:outcome.written?text.length:0,
        status:outcome.effect_unknown?'effect_unknown':outcome.written?'executed':'not_executed',focusedVia:'native_bound_editor' };
    }

    const result = await ctx.cdp.send<{ result: { value: any } }>(
      tabId, "Runtime.evaluate",
      { expression: FIND_ELEMENT_SCRIPT(nodeId), returnByValue: true }
    );

    const info = result.result.value;
    if (!info) throw new Error(`type_element: node "${nodeId}" not found. Run get_visible_dom first.`);

    // Visual cursor feedback only (the overlay never focuses anything).
    // (H02 bisection neutralization REVERTED 2026-10-04 — azo-2 decision m_mutoa6pf:
    //  hypothesis refuted by DIAGNOSIS-INSTRUMENT-DEFECT.md; typing was never broken.)
    await moveCursor(tabId, info.centerX, info.centerY, true);
    await cursorClickEffect(tabId, info.centerX, info.centerY);

    // focus:false — write-through the native setter with NO focus and NO mouse.
    // This is the reliable path for multi-field work: measured on Chrome
    // (2026-09) a tab loses its `chrome.debugger` attachment after ~2
    // focus-taking operations on editable fields (real click, el.focus() or
    // DOM.focus alike), while this path stays stable over long runs.
    if (focus === false) {
      const written = await ctx.cdp.send<{ result: { value: { found?: boolean; value?: string } } }>(
        tabId,
        "Runtime.evaluate",
        { expression: SET_VALUE_EXPRESSION(nodeId, text, clearFirst), returnByValue: true }
      );
      const outcome = written.result.value;
      if (outcome?.found === false) {
        throw new Error(`type_element: node "${nodeId}" disappeared before it could be filled`);
      }
      return {
        tabId,
        nodeId,
        typed: text.length,
        tag: info.tag,
        focusedVia: "none",
        value: outcome?.value ?? null,
      };
    }

    // Focus through the DOM domain. The previous implementation clicked the
    // field with a real mouse event, which focuses it and hits the same ceiling.
    const focused = await focusByNodeId(ctx, tabId, nodeId);
    if (!focused) {
      // Fallback for elements the DOM domain cannot focus: real mouse click.
      await ctx.cdp.send(tabId, "Input.dispatchMouseEvent", {
        type: "mousePressed", x: info.centerX, y: info.centerY,
        button: "left", clickCount: 1, buttons: 1,
      });
      await ctx.cdp.send(tabId, "Input.dispatchMouseEvent", {
        type: "mouseReleased", x: info.centerX, y: info.centerY,
        button: "left", clickCount: 1,
      });
    }

    if (clearFirst) {
      // Native value setter (framework-safe) and — deliberately — no focus call.
      await ctx.cdp.send(tabId, "Runtime.evaluate", {
        expression: CLEAR_VALUE_EXPRESSION(nodeId),
        returnByValue: true,
      });
    }

    await ctx.cdp.send(tabId, "Input.insertText", { text });

    const readBack = await ctx.cdp.send<{ result: { value: unknown } }>(tabId, "Runtime.evaluate", {
      expression: `(() => { const el = document.querySelector('[data-wb-id="${nodeId}"]'); return el && 'value' in el ? String(el.value) : null; })()`,
      returnByValue: true,
    });

    return {
      tabId,
      nodeId,
      typed: text.length,
      tag: info.tag,
      focusedVia: focused ? "dom" : "mouse",
      value: typeof readBack.result.value === "string" ? readBack.result.value.slice(0, 120) : null,
    };
  }
}

/**
 * Focus an element without a real mouse click: resolve it in the DOM domain, then
 * `DOM.focus`. Returns false when the element cannot be resolved/focused so the
 * caller can fall back to the click path.
 */
async function focusByNodeId(ctx: ToolContext, tabId: number, nodeId: string): Promise<boolean> {
  try {
    // Give the window focus first. Measured on Chrome (2026-09): focusing an
    // editable field while the Chrome window is in the background triggers a
    // window activation that invalidates the tab's `chrome.debugger` attachment
    // ("Cannot access a chrome-extension:// URL of different extension").
    // Activating the window up front removes that transition.
    const tab = await chrome.tabs.get(tabId);
    if (tab?.windowId !== undefined) {
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
    }
    // H02 fix (2026-10-04): focus in PAGE CONTEXT via Runtime.evaluate instead of
    // DOM.getDocument -> DOM.querySelector -> DOM.focus. The DOM-domain focus
    // invalidates the debugger attachment asynchronously on the SECOND invocation
    // ("Detached while handling command", then the tab's CDP is permanently stale
    // until reload - reproduced in h02 fixture, focus:true x2). el.focus() needs
    // no DOM-domain node resolution, so the attachment never churns. Works on
    // background tabs (activeElement is set; CDP Input events reach it).
    const focused = await ctx.cdp.send<{ result: { value: boolean } }>(
      tabId,
      "Runtime.evaluate",
      {
        expression: `(() => { const el = document.querySelector('[data-wb-id="${nodeId}"]'); if (!el) return false; el.focus(); return document.activeElement === el; })()`,
        returnByValue: true,
      }
    );
    return focused?.result?.value === true;
  } catch {
    return false;
  }
}

/** Nothing here calls focus(): that is what keeps the tab's debugger attachment alive. */
function CLEAR_VALUE_EXPRESSION(nodeId: string): string {
  return `(() => {
  const el = document.querySelector('[data-wb-id="${nodeId}"]');
  if (!el || !('value' in el)) return { cleared: false };
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, '');
  else el.value = '';
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { cleared: true };
})()`;
}

/**
 * Native-setter write used by `focus:false`. Emits `input` + `change` so
 * frameworks (React/Vue controlled inputs) register the change, and never
 * focuses the element. Returns the value actually present afterwards.
 */
function SET_VALUE_EXPRESSION(nodeId: string, text: string, clearFirst: boolean): string {
  return `(() => {
  const el = document.querySelector('[data-wb-id="${nodeId}"]');
  if (!el) return { found: false };
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if ('value' in el) {
    if (${clearFirst ? "true" : "false"} && setter) {
      setter.call(el, '');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (setter) setter.call(el, ${JSON.stringify(text)});
    else el.value = ${JSON.stringify(text)};
  } else {
    el.textContent = ${JSON.stringify(text)};
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { found: true, value: 'value' in el ? String(el.value).slice(0, 120) : null };
})()`;
}

export class HighlightTool extends BaseTool {
  readonly name = "highlight" as const;
  readonly description = "Highlight a DOM element by node ID (visual debugging)";

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
    const { nodeId, tabId: rawTabId, clear = false } = args as unknown as HighlightArgs;
    const tabId = await resolveTabId(rawTabId);

    if (clear || !nodeId) {
      await highlightRect(tabId, null);
      return { tabId, highlighted: false };
    }

    const result = await ctx.cdp.send<{ result: { value: any } }>(
      tabId, "Runtime.evaluate",
      { expression: FIND_ELEMENT_SCRIPT(nodeId), returnByValue: true }
    );

    const info = result.result.value;
    if (!info) throw new Error(`highlight: node "${nodeId}" not found`);

    await highlightRect(tabId, info.rect);
    return { tabId, nodeId, rect: info.rect };
  }
}
