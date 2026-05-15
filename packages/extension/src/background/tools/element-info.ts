import type { ElementInfoArgs } from "@webbridge/shared";
import { BaseTool, type ToolContext } from "./base.js";
import { resolveTabId } from "../../cdp/session.js";

const ELEMENT_AT_POINT_SCRIPT = (x: number, y: number) => `
(() => {
  const el = document.elementFromPoint(${x}, ${y});
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  return {
    tag: el.tagName.toLowerCase(),
    id: el.id || undefined,
    className: el.className || undefined,
    text: (el.textContent || '').trim().substring(0, 120),
    role: el.getAttribute('role') || el.closest('[role]')?.getAttribute('role') || undefined,
    ariaLabel: el.getAttribute('aria-label') || undefined,
    href: el.getAttribute('href') || undefined,
    type: el.getAttribute('type') || undefined,
    placeholder: el.getAttribute('placeholder') || undefined,
    value: ('value' in el) ? String(el.value).substring(0, 80) : undefined,
    isEditable: el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT',
    isVisible: cs.display !== 'none' && cs.visibility !== 'hidden',
    rect: {
      x: Math.round(rect.x), y: Math.round(rect.y),
      width: Math.round(rect.width), height: Math.round(rect.height)
    },
    wbId: el.getAttribute('data-wb-id') || undefined,
    selectors: [
      el.id ? '#' + el.id : null,
      el.getAttribute('data-testid') ? '[data-testid="' + el.getAttribute('data-testid') + '"]' : null,
      el.getAttribute('aria-label') ? '[aria-label="' + el.getAttribute('aria-label') + '"]' : null,
      el.tagName.toLowerCase() + (el.className ? '.' + el.className.trim().split(/\\s+/).join('.') : ''),
    ].filter(Boolean)
  };
})()
`;

export class ElementInfoTool extends BaseTool {
  readonly name = "element_info" as const;
  readonly description = "Get detailed info about the element at given coordinates";

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
    const { x, y, tabId: rawTabId } = args as unknown as ElementInfoArgs;
    if (x === undefined || y === undefined) {
      throw new Error("element_info: x and y are required");
    }

    const tabId = await resolveTabId(rawTabId);

    const result = await ctx.cdp.send<{ result: { value: unknown } }>(
      tabId,
      "Runtime.evaluate",
      { expression: ELEMENT_AT_POINT_SCRIPT(x, y), returnByValue: true }
    );

    const info = result.result.value;
    if (!info) {
      return { tabId, x, y, found: false };
    }

    return { tabId, x, y, found: true, element: info };
  }
}
