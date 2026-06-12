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

      for (const node of tree.nodes) {
        if (compactNodes.length >= maxNodes) break;
        const role = node.role?.value as string | undefined;
        const name = node.name?.value as string | undefined;
        const backendNodeId = node.backendDOMNodeId as number | undefined;
        if (!role) continue;
        if (!includeHidden && (node.ignored === true || node.hidden === true)) continue;

        const interactive = INTERACTIVE_ROLES.has(role);
        const structural = STRUCTURAL_ROLES.has(role);
        if (!interactive && !structural && !name) continue;

        if (backendNodeId !== undefined) backendNodeIds.push(backendNodeId);
        compactNodes.push({
          backendNodeId,
          role,
          name,
          value: node.value?.value,
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
