import type { ExtractLinksArgs, ExtractTableArgs, ExtractTextArgs } from "@webbridge/shared";
import { BaseTool, type ToolContext } from "./base.js";
import { resolveTabId } from "../../cdp/session.js";

export class ExtractLinksTool extends BaseTool {
  readonly name = "extract_links" as const;
  readonly description = "Extract a compact, filtered list of links without returning a full DOM snapshot";

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
    const { tabId: rawTabId } = args as unknown as ExtractLinksArgs;
    const tabId = await resolveTabId(rawTabId);
    const value = await runInPage(tabId, ctx, extractLinksInPage, args);
    return { tabId, ...value };
  }
}

export class ExtractTextTool extends BaseTool {
  readonly name = "extract_text" as const;
  readonly description = "Extract bounded page text or snippets around search terms";

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
    const { tabId: rawTabId } = args as unknown as ExtractTextArgs;
    const tabId = await resolveTabId(rawTabId);
    const value = await runInPage(tabId, ctx, extractTextInPage, args);
    return { tabId, ...value };
  }
}

export class ExtractTableTool extends BaseTool {
  readonly name = "extract_table" as const;
  readonly description = "Extract compact table/grid data with row/column/character budgets";

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
    const { tabId: rawTabId } = args as unknown as ExtractTableArgs;
    const tabId = await resolveTabId(rawTabId);
    const value = await runInPage(tabId, ctx, extractTableInPage, args);
    return { tabId, ...value };
  }
}

async function runInPage(
  tabId: number,
  ctx: ToolContext,
  extractor: (rawArgs: any) => unknown,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await ctx.cdp.send<{
    result: { value?: unknown; description?: string };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  }>(tabId, "Runtime.evaluate", {
    expression: buildExtractorExpression(extractor, args),
    returnByValue: true,
    awaitPromise: true,
  });

  if (result.exceptionDetails) {
    throw new Error(`extractor JS error: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "unknown"}`);
  }
  if (!result.result.value || typeof result.result.value !== "object") {
    throw new Error(`extractor returned no serializable value: ${result.result.description ?? typeof result.result.value}`);
  }
  return result.result.value as Record<string, unknown>;
}

function buildExtractorExpression(extractor: (rawArgs: any) => unknown, args: Record<string, unknown>): string {
  return `(() => {\n${PAGE_HELPERS}\nreturn (${extractor.toString()})(${JSON.stringify(args)});\n})()`;
}

const PAGE_HELPERS = [
  normalizeText,
  toLowerArray,
  clampNumber,
  isVisible,
  truncate,
  findPositions,
  boundJson,
  parseTableElement,
  extractCell,
].map((fn) => fn.toString()).join("\n");

function extractLinksInPage(rawArgs: ExtractLinksArgs) {
  const args = rawArgs || {};
  const limit = clampNumber(args.limit, 1, 200, 30);
  const maxTextLength = clampNumber(args.maxTextLength, 20, 1_000, 180);
  const hrefIncludes = toLowerArray(args.hrefIncludes);
  const hrefExcludes = toLowerArray(args.hrefExcludes);
  const textIncludes = toLowerArray(args.textIncludes);
  const textExcludes = toLowerArray(args.textExcludes);
  const root = args.selector ? document.querySelector(args.selector) : document;
  const links = root ? Array.from(root.querySelectorAll("a[href]")) : [];
  const output: Array<Record<string, unknown>> = [];
  let matched = 0;

  for (const anchor of links as HTMLAnchorElement[]) {
    const href = anchor.href || anchor.getAttribute("href") || "";
    const rawHref = anchor.getAttribute("href") || href;
    if (!args.includeHashLinks && (rawHref.startsWith("#") || rawHref.toLowerCase().startsWith("javascript:"))) continue;
    const text = normalizeText(anchor.innerText || anchor.textContent || anchor.getAttribute("aria-label") || anchor.title || "");
    const searchable = `${text} ${href}`.toLowerCase();
    if (!args.includeHidden && !isVisible(anchor)) continue;
    if (hrefIncludes.length && !hrefIncludes.some((needle) => href.toLowerCase().includes(needle))) continue;
    if (hrefExcludes.some((needle) => href.toLowerCase().includes(needle))) continue;
    if (textIncludes.length && !textIncludes.some((needle) => searchable.includes(needle))) continue;
    if (textExcludes.some((needle) => searchable.includes(needle))) continue;

    matched++;
    if (output.length >= limit) continue;
    output.push({
      text: truncate(text, maxTextLength).value,
      href,
      title: anchor.title || undefined,
      ariaLabel: anchor.getAttribute("aria-label") || undefined,
      rel: anchor.getAttribute("rel") || undefined,
    });
  }

  return {
    url: location.href,
    title: document.title,
    selector: args.selector,
    links: output,
    count: output.length,
    matched,
    totalCandidates: links.length,
    truncated: matched > output.length,
  };
}

function extractTextInPage(rawArgs: ExtractTextArgs) {
  const args = rawArgs || {};
  const maxChars = clampNumber(args.maxChars, 100, 50_000, 2_000);
  const around = clampNumber(args.around, 40, 4_000, 300);
  const maxMatches = clampNumber(args.maxMatches, 1, 100, 20);
  const separator = typeof args.separator === "string" ? args.separator : "\n---\n";
  const includes = toLowerArray(args.includes);
  const excludes = toLowerArray(args.excludes);
  const selectors = Array.isArray(args.selectors)
    ? args.selectors.filter((v): v is string => typeof v === "string" && v.length > 0)
    : args.selector
      ? [args.selector]
      : [];

  const sections = selectors.length
    ? selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)).map((el, index) => ({ selector, index, text: normalizeText((el as HTMLElement).innerText || el.textContent || "") })))
    : [{ selector: undefined as string | undefined, index: 0, text: normalizeText(document.body?.innerText || document.documentElement?.textContent || "") }];

  const filteredSections = sections.filter((section) => {
    const lower = section.text.toLowerCase();
    if (excludes.some((needle) => lower.includes(needle))) return false;
    return true;
  });

  const wantsSnippets = args.mode === "snippets" || includes.length > 0;
  if (wantsSnippets) {
    const snippets: Array<Record<string, unknown>> = [];
    let totalMatches = 0;
    for (const section of filteredSections) {
      const lower = section.text.toLowerCase();
      const needles = includes.length ? includes : [""];
      for (const needle of needles) {
        const positions = needle ? findPositions(lower, needle) : [0];
        totalMatches += positions.length;
        for (const position of positions) {
          if (snippets.length >= maxMatches) continue;
          const start = Math.max(0, position - around);
          const end = Math.min(section.text.length, position + needle.length + around);
          const snippet = section.text.slice(start, end);
          snippets.push({
            selector: section.selector,
            index: section.index,
            match: needle || undefined,
            beforeTruncated: start > 0,
            afterTruncated: end < section.text.length,
            text: snippet,
          });
        }
      }
    }

    const bounded = boundJson(snippets, maxChars);
    return {
      url: location.href,
      title: document.title,
      mode: "snippets",
      snippets: bounded.value,
      count: Array.isArray(bounded.value) ? bounded.value.length : snippets.length,
      totalMatches,
      chars: bounded.chars,
      truncated: bounded.truncated || totalMatches > snippets.length,
    };
  }

  const joined = filteredSections.map((section) => section.text).filter(Boolean).join(separator);
  const bounded = truncate(joined, maxChars);
  return {
    url: location.href,
    title: document.title,
    mode: "text",
    selector: args.selector,
    text: bounded.value,
    sections: filteredSections.length,
    chars: joined.length,
    truncated: bounded.truncated,
  };
}

function extractTableInPage(rawArgs: ExtractTableArgs) {
  const args = rawArgs || {};
  const maxTables = clampNumber(args.maxTables, 1, 20, args.index !== undefined ? 1 : 3);
  const maxRows = clampNumber(args.maxRows, 1, 500, 25);
  const maxCols = clampNumber(args.maxCols, 1, 50, 10);
  const maxCellLength = clampNumber(args.maxCellLength, 20, 2_000, 120);
  const maxChars = clampNumber(args.maxChars, 500, 100_000, 4_000);
  const selector = args.selector || "table,[role='table'],[role='grid']";
  const candidates = Array.from(document.querySelectorAll(selector));
  const selected = args.index !== undefined ? candidates.slice(args.index, args.index + 1) : candidates.slice(0, maxTables);
  const tables = selected.map((el, index) => parseTableElement(el as HTMLElement, {
    index: args.index ?? index,
    maxRows,
    maxCols,
    maxCellLength,
    includeLinks: args.includeLinks === true,
  }));

  const bounded = boundJson(tables, maxChars);
  return {
    url: location.href,
    title: document.title,
    selector,
    tables: bounded.value,
    count: Array.isArray(bounded.value) ? bounded.value.length : tables.length,
    totalCandidates: candidates.length,
    chars: bounded.chars,
    truncated: bounded.truncated || candidates.length > selected.length || tables.some((table) => table.truncated),
  };
}

function parseTableElement(el: HTMLElement, options: { index: number; maxRows: number; maxCols: number; maxCellLength: number; includeLinks: boolean }) {
  const rowEls = Array.from(el.querySelectorAll("tr,[role='row']"));
  const rows = rowEls.map((row) => Array.from(row.querySelectorAll("th,td,[role='columnheader'],[role='rowheader'],[role='cell'],[role='gridcell']")) as HTMLElement[])
    .filter((cells) => cells.length > 0);
  const headerCells = rows.find((cells) => cells.some((cell) => cell.tagName === "TH" || cell.getAttribute("role")?.includes("header")));
  const headers = headerCells?.slice(0, options.maxCols).map((cell) => extractCell(cell, options)) ?? [];
  const dataRows = rows.filter((cells) => cells !== headerCells).slice(0, options.maxRows).map((cells) => cells.slice(0, options.maxCols).map((cell) => extractCell(cell, options)));
  const caption = normalizeText((el.querySelector("caption") as HTMLElement | null)?.innerText || el.getAttribute("aria-label") || "");
  return {
    index: options.index,
    caption: caption || undefined,
    headers,
    rows: dataRows,
    rowCount: Math.max(0, rows.length - (headerCells ? 1 : 0)),
    returnedRows: dataRows.length,
    columnCount: Math.max(0, ...rows.map((cells) => cells.length)),
    truncated: rows.length - (headerCells ? 1 : 0) > dataRows.length || rows.some((cells) => cells.length > options.maxCols),
  };
}

function extractCell(cell: HTMLElement, options: { maxCellLength: number; includeLinks: boolean }) {
  const text = truncate(normalizeText(cell.innerText || cell.textContent || ""), options.maxCellLength).value;
  if (!options.includeLinks) return text;
  const links = Array.from(cell.querySelectorAll("a[href]")).slice(0, 5).map((a) => ({
    text: truncate(normalizeText((a as HTMLElement).innerText || a.textContent || ""), 80).value,
    href: (a as HTMLAnchorElement).href,
  }));
  return { text, links };
}

function normalizeText(value: string): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function toLowerArray(value: unknown): string[] {
  if (typeof value === "string") return value ? [value.toLowerCase()] : [];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string" && v.length > 0).map((v) => v.toLowerCase());
  return [];
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const number = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function isVisible(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  const style = getComputedStyle(el);
  return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
}

function truncate(value: string, maxChars: number): { value: string; truncated: boolean } {
  if (value.length <= maxChars) return { value, truncated: false };
  return { value: value.slice(0, Math.max(0, maxChars - 1)) + "…", truncated: true };
}

function findPositions(haystack: string, needle: string): number[] {
  const positions: number[] = [];
  if (!needle) return positions;
  let offset = 0;
  while (offset < haystack.length) {
    const index = haystack.indexOf(needle, offset);
    if (index === -1) break;
    positions.push(index);
    offset = index + Math.max(needle.length, 1);
  }
  return positions;
}

function boundJson<T>(value: T, maxChars: number): { value: T | unknown; chars: number; truncated: boolean } {
  const raw = JSON.stringify(value);
  if (raw.length <= maxChars) return { value, chars: raw.length, truncated: false };
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    for (const item of value) {
      const next = [...output, item];
      if (JSON.stringify(next).length > maxChars) break;
      output.push(item);
    }
    return { value: output, chars: raw.length, truncated: true };
  }
  return { value: truncate(raw, maxChars).value, chars: raw.length, truncated: true };
}
