import type {
  GetVisibleDomArgs,
  ClickElementArgs,
  TypeElementArgs,
  HighlightArgs,
} from "@webbridge/shared";
import { BaseTool, type ToolContext } from "./base.js";
import { resolveTabId } from "../../cdp/session.js";
import { moveCursor, cursorClickEffect, highlightRect } from "../../cdp/cursor.js";

const GET_VISIBLE_DOM_SCRIPT = `
(() => {
  const INTERACTIVE = 'a,button,input,select,textarea,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[contenteditable="true"],[onclick],[tabindex]';
  const seen = new Set();
  const nodes = [];
  let counter = 0;

  document.querySelectorAll(INTERACTIVE).forEach(el => {
    if (seen.has(el)) return;
    seen.add(el);

    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;
    if (rect.bottom < 0 || rect.top > window.innerHeight) return;
    if (rect.right < 0 || rect.left > window.innerWidth) return;

    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return;

    const id = 'n' + (++counter);
    el.setAttribute('data-wb-id', id);

    const tag = el.tagName.toLowerCase();
    const text = (el.textContent || '').trim().substring(0, 80);
    const role = el.getAttribute('role') || undefined;
    const href = el.getAttribute('href') || undefined;
    const type = el.getAttribute('type') || undefined;
    const placeholder = el.getAttribute('placeholder') || undefined;
    const ariaLabel = el.getAttribute('aria-label') || undefined;
    const value = (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)
      ? el.value.substring(0, 80)
      : undefined;

    nodes.push({
      id, tag, text: text || undefined,
      role, href, type, placeholder, ariaLabel, value,
      rect: {
        x: Math.round(rect.x), y: Math.round(rect.y),
        width: Math.round(rect.width), height: Math.round(rect.height)
      }
    });
  });

  return nodes;
})()
`;

export class GetVisibleDomTool extends BaseTool {
  readonly name = "get_visible_dom" as const;
  readonly description = "Get visible interactable DOM elements with node IDs";

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
    const { tabId: rawTabId } = args as unknown as GetVisibleDomArgs;
    const tabId = await resolveTabId(rawTabId);

    const result = await ctx.cdp.send<{
      result: { value: unknown };
    }>(tabId, "Runtime.evaluate", {
      expression: GET_VISIBLE_DOM_SCRIPT,
      returnByValue: true,
      awaitPromise: false,
    });

    return result.result.value;
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
    const { nodeId, tabId: rawTabId } = args as unknown as ClickElementArgs;
    if (!nodeId) throw new Error("click_element: nodeId is required");

    const tabId = await resolveTabId(rawTabId);

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
  readonly description = "Click a DOM element by node ID and type text into it";

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
    const { nodeId, text, tabId: rawTabId, clearFirst = true } = args as unknown as TypeElementArgs;
    if (!nodeId) throw new Error("type_element: nodeId is required");
    if (text === undefined) throw new Error("type_element: text is required");

    const tabId = await resolveTabId(rawTabId);

    const result = await ctx.cdp.send<{ result: { value: any } }>(
      tabId, "Runtime.evaluate",
      { expression: FIND_ELEMENT_SCRIPT(nodeId), returnByValue: true }
    );

    const info = result.result.value;
    if (!info) throw new Error(`type_element: node "${nodeId}" not found. Run get_visible_dom first.`);

    await moveCursor(tabId, info.centerX, info.centerY, true);
    await cursorClickEffect(tabId, info.centerX, info.centerY);

    // Click to focus
    await ctx.cdp.send(tabId, "Input.dispatchMouseEvent", {
      type: "mousePressed", x: info.centerX, y: info.centerY,
      button: "left", clickCount: 1, buttons: 1,
    });
    await ctx.cdp.send(tabId, "Input.dispatchMouseEvent", {
      type: "mouseReleased", x: info.centerX, y: info.centerY,
      button: "left", clickCount: 1,
    });

    if (clearFirst) {
      await ctx.cdp.send(tabId, "Runtime.evaluate", {
        expression: `(() => { const el = document.querySelector('[data-wb-id="${nodeId}"]'); if(el && 'value' in el) { el.value = ''; el.dispatchEvent(new Event('input', {bubbles:true})); } })()`,
        returnByValue: true,
      });
    }

    await ctx.cdp.send(tabId, "Input.insertText", { text });

    return { tabId, nodeId, typed: text.length, tag: info.tag };
  }
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
