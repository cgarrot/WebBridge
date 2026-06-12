import type { SnapshotArgs } from "@webbridge/shared";
import { BaseTool, type ToolContext } from "./base.js";
import { resolveTabId } from "../../cdp/session.js";
import { replaceElementRefs } from "../element-ref-store.js";

const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "combobox",
  "checkbox",
  "radio",
  "slider",
  "tab",
  "menuitem",
  "searchbox",
  "spinbutton",
]);

const STRUCTURAL_ROLES = new Set([
  "heading",
  "main",
  "navigation",
  "article",
  "section",
  "form",
  "dialog",
  "alert",
  "list",
  "listitem",
  "table",
  "row",
  "cell",
]);

export class SnapshotTool extends BaseTool {
  readonly name = "snapshot" as const;
  readonly description = "Get a DOM or accessibility tree snapshot";

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
    const {
      tabId: rawTabId,
      type = "dom",
      mode = "compact",
      maxNodes = 300,
      includeHidden = false,
      roles,
      textIncludes,
      maxTextLength = 180,
    } = args as unknown as SnapshotArgs;
    const tabId = await resolveTabId(rawTabId);

    if (type === "accessibility") {
      await ctx.cdp.send(tabId, "Accessibility.enable");
      const tree = await ctx.cdp.send<{ nodes: Array<Record<string, any>> }>(
        tabId,
        "Accessibility.getFullAXTree"
      );

      if (mode === "full") {
        return { tabId, type: "accessibility", mode: "full", nodes: tree.nodes };
      }

      const compactNodes: Array<Record<string, unknown>> = [];
      const backendNodeIds: number[] = [];
      const roleFilter = new Set((roles ?? []).map((role) => role.toLowerCase()));
      const textNeedles = toLowerArray(textIncludes);
      const textBudget = Math.max(20, Math.min(1_000, maxTextLength));
      let matchedBeforeLimit = 0;

      for (const node of tree.nodes) {
        const role = node.role?.value as string | undefined;
        const rawName = node.name?.value as string | undefined;
        const rawValue = node.value?.value as string | undefined;
        const backendNodeId = node.backendDOMNodeId as number | undefined;
        if (!role) continue;
        if (!includeHidden && (node.ignored === true || node.hidden === true)) continue;
        if (roleFilter.size > 0 && !roleFilter.has(role.toLowerCase())) continue;

        const searchable = `${rawName ?? ""} ${rawValue ?? ""}`.toLowerCase();
        if (textNeedles.length > 0 && !textNeedles.some((needle) => searchable.includes(needle))) continue;

        const interactive = INTERACTIVE_ROLES.has(role);
        const structural = STRUCTURAL_ROLES.has(role);
        if (!interactive && !structural && !rawName && !rawValue) continue;

        matchedBeforeLimit++;
        if (compactNodes.length >= maxNodes) continue;
        if (backendNodeId !== undefined) backendNodeIds.push(backendNodeId);
        const name = rawName ? truncate(rawName, textBudget).value : undefined;
        const value = rawValue ? truncate(rawValue, textBudget).value : undefined;
        compactNodes.push({
          backendNodeId,
          role,
          name,
          value,
          clickable: interactive || undefined,
          editable: role === "textbox" || role === "searchbox" || role === "combobox" || undefined,
        });
      }

      const refLabels = replaceElementRefs(tabId, backendNodeIds);
      for (const node of compactNodes) {
        const backendNodeId = node.backendNodeId;
        if (typeof backendNodeId === "number") {
          node.ref = refLabels.get(backendNodeId);
        }
        delete node.backendNodeId;
      }

      const tab = await chrome.tabs.get(tabId);
      return {
        tabId,
        type: "accessibility",
        mode: "compact",
        url: tab.url,
        title: tab.title,
        tree: compactNodes,
        count: compactNodes.length,
        matched: matchedBeforeLimit,
        truncated: matchedBeforeLimit > compactNodes.length,
      };
    }

    const result = await ctx.cdp.send<{
      result: { value: string };
    }>(tabId, "Runtime.evaluate", {
      expression: "document.documentElement.outerHTML",
      returnByValue: true,
    });

    return { tabId, type: "dom", html: result.result.value };
  }
}

function toLowerArray(value: unknown): string[] {
  if (typeof value === "string") return value ? [value.toLowerCase()] : [];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string" && item.length > 0).map((item) => item.toLowerCase());
  return [];
}

function truncate(value: string, maxChars: number): { value: string; truncated: boolean } {
  if (value.length <= maxChars) return { value, truncated: false };
  return { value: value.slice(0, Math.max(0, maxChars - 1)) + "…", truncated: true };
}
