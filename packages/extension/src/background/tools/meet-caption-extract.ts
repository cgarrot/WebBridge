import type { MeetCaptionExtractArgs } from "@webbridge/shared";
import { BaseTool, type ToolContext } from "./base.js";
import { resolveTabId } from "../../cdp/session.js";

export class MeetCaptionExtractTool extends BaseTool {
  readonly name = "meet_caption_extract" as const;
  readonly description = "Extract bounded Google Meet live caption candidates and speaker/text rows from the page DOM";

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
    const { tabId: rawTabId } = args as unknown as MeetCaptionExtractArgs;
    const tabId = await resolveTabId(rawTabId);
    const result = await ctx.cdp.send<{
      result: { value?: unknown; description?: string };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>(tabId, "Runtime.evaluate", {
      expression: buildExtractorExpression(args),
      returnByValue: true,
      awaitPromise: true,
    });

    if (result.exceptionDetails) {
      throw new Error(`meet_caption_extract JS error: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "unknown"}`);
    }
    if (!result.result.value || typeof result.result.value !== "object") {
      throw new Error(`meet_caption_extract returned no serializable value: ${result.result.description ?? typeof result.result.value}`);
    }
    return { tabId, ...(result.result.value as Record<string, unknown>) };
  }
}

function buildExtractorExpression(args: Record<string, unknown>): string {
  return `(() => {\n${PAGE_HELPERS}\nreturn (${extractMeetCaptionsInPage.toString()})(${JSON.stringify(args)});\n})()`;
}

const PAGE_HELPERS = [
  normalizeText,
  truncate,
  clampNumber,
  isVisible,
  cssPath,
  isLikelyControlText,
  splitCaptionText,
  isPotentialCaptionText,
  boundJson,
].map((fn) => fn.toString()).join("\n");

function extractMeetCaptionsInPage(rawArgs: MeetCaptionExtractArgs) {
  const args = rawArgs || {};
  const maxCaptions = clampNumber(args.maxCaptions, 1, 100, 20);
  const maxCandidates = clampNumber(args.maxCandidates, 1, 200, 40);
  const maxTextLength = clampNumber(args.maxTextLength, 20, 2_000, 300);
  const maxChars = clampNumber(args.maxChars, 500, 100_000, 8_000);
  const includeHidden = args.includeHidden === true;
  const dedupe = args.dedupe !== false;
  const now = Date.now();

  const knownSelectors = [
    args.selector,
    "[aria-live='polite']",
    "[aria-live='assertive']",
    "[role='status']",
    "[data-message-text]",
    ".iOzk7",
    ".TBMuR",
    ".a4cQT",
    ".bh44bd",
    ".KcIKyf",
    ".MuzmKe",
  ].filter((selector): selector is string => typeof selector === "string" && selector.length > 0);

  const elementSet = new Set<Element>();
  for (const selector of knownSelectors) {
    try {
      for (const el of Array.from(document.querySelectorAll(selector))) elementSet.add(el);
    } catch {
      // Ignore caller/Meet selector drift.
    }
  }

  const bottomCutoff = window.innerHeight * 0.45;
  const allElements = Array.from(document.querySelectorAll("div,span,p,[aria-label],[role='status']"));
  for (const el of allElements) {
    const htmlEl = el as HTMLElement;
    const text = normalizeText(htmlEl.innerText || htmlEl.textContent || htmlEl.getAttribute("aria-label") || "");
    if (!text || text.length < 2 || text.length > 1_500) continue;
    const rect = htmlEl.getBoundingClientRect();
    const inCaptionArea = rect.bottom >= bottomCutoff && rect.width > 20 && rect.height > 5;
    const liveish = Boolean(htmlEl.getAttribute("aria-live") || htmlEl.getAttribute("role") === "status");
    if (inCaptionArea || liveish) elementSet.add(el);
  }

  const candidates: Array<Record<string, unknown>> = [];
  const captions: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();

  for (const el of elementSet) {
    const htmlEl = el as HTMLElement;
    if (!includeHidden && !isVisible(htmlEl)) continue;
    const rawText = normalizeText(htmlEl.innerText || htmlEl.textContent || htmlEl.getAttribute("aria-label") || "");
    if (!rawText || isLikelyControlText(rawText)) continue;

    const rect = htmlEl.getBoundingClientRect();
    const source = knownSelectors.find((selector) => {
      try { return htmlEl.matches(selector); } catch { return false; }
    }) || "bottom-visible";
    const split = splitCaptionText(rawText);
    const text = truncate(split.text, maxTextLength).value;
    if (!text || isLikelyControlText(text)) continue;

    const likelyCaption = isPotentialCaptionText(rawText, split, source);
    const key = `${split.speaker || ""}\n${text}`.toLowerCase();
    if (dedupe && seen.has(key)) continue;
    seen.add(key);

    const row = {
      speaker: split.speaker,
      text,
      rawText: truncate(rawText, maxTextLength).value,
      source,
      likelyCaption,
      selector: cssPath(htmlEl),
      ariaLive: htmlEl.getAttribute("aria-live") || undefined,
      role: htmlEl.getAttribute("role") || undefined,
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      observedAt: now,
    };

    if (candidates.length < maxCandidates) candidates.push(row);
    if (likelyCaption && captions.length < maxCaptions) captions.push(row);
    if (captions.length >= maxCaptions && candidates.length >= maxCandidates) break;
  }

  const boundedCaptions = boundJson(captions.slice(0, maxCaptions), maxChars);
  const remainingBudget = Math.max(500, maxChars - boundedCaptions.chars);
  const boundedCandidates = boundJson(candidates.slice(0, maxCandidates), remainingBudget);

  return {
    url: location.href,
    title: document.title,
    observedAt: now,
    captions: boundedCaptions.value,
    candidates: boundedCandidates.value,
    count: Array.isArray(boundedCaptions.value) ? boundedCaptions.value.length : captions.length,
    candidateCount: candidates.length,
    captionUiLikelyOn: document.body.innerText.toLowerCase().includes("turn off captions") || candidates.length > 0,
    truncated: boundedCaptions.truncated || boundedCandidates.truncated || captions.length > maxCaptions || candidates.length > maxCandidates,
    guidance: captions.length > 0
      ? "Use captions[].speaker/text as the low-latency STT fallback. Poll this tool and dedupe by observedAt+speaker+text."
      : "No caption text found. In Meet, click Turn on captions first, wait for speech, or pass a selector from candidates/DOM inspection if Meet changed its markup.",
  };
}

function normalizeText(value: string): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxChars: number): { value: string; truncated: boolean } {
  if (value.length <= maxChars) return { value, truncated: false };
  return { value: value.slice(0, Math.max(0, maxChars - 1)) + "…", truncated: true };
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const number = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function isVisible(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  const style = getComputedStyle(el);
  return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
}

function cssPath(el: Element): string {
  const parts: string[] = [];
  let current: Element | null = el;
  while (current && parts.length < 5 && current !== document.body && current !== document.documentElement) {
    let part = current.tagName.toLowerCase();
    const role = current.getAttribute("role");
    const jsname = current.getAttribute("jsname");
    if (role) part += `[role='${role.replace(/'/g, "\\'")}']`;
    if (jsname) part += `[jsname='${jsname.replace(/'/g, "\\'")}']`;
    const className = typeof (current as HTMLElement).className === "string" ? (current as HTMLElement).className.trim().split(/\s+/).slice(0, 2).join(".") : "";
    if (className) part += `.${className}`;
    parts.unshift(part);
    current = current.parentElement;
  }
  return parts.join(" > ");
}

function isLikelyControlText(text: string): boolean {
  const lower = text.toLowerCase();
  const controls = [
    "turn off captions",
    "turn on captions",
    "open caption settings",
    "font size",
    "font color",
    "meeting details",
    "leave call",
    "chat with everyone",
    "host controls",
    "meeting tools",
    "raise hand",
    "send a reaction",
    "share screen",
    "audio settings",
    "video settings",
    "more options",
    "press down arrow",
    "jump to bottom",
    "language english",
    "backgrounds and effects",
    "more options for",
    "frame_person",
    "visual_effects",
    "devices",
    "reframe",
    "your camera is off",
    "your microphone is off",
  ];
  const strongControls = [
    "jump to bottom",
    "backgrounds and effects",
    "more options for",
    "open caption settings",
    "turn off captions",
    "turn on captions",
  ];
  if (strongControls.some((control) => lower.includes(control))) return true;

  const hits = controls.filter((control) => lower.includes(control)).length;
  if (hits >= 2) return true;
  if (controls.some((control) => lower === control)) return true;
  const iconOnly = /^(closed_caption|closed_caption_off|keyboard_arrow_up|arrow_downward|more_vert|call_end|chat|apps|lock_person|back_hand|mood|computer_arrow_up|mic|videocam|language|format_size|circle)(\s+\1)*$/i;
  return iconOnly.test(text.replace(/\s+/g, "_"));
}

function splitCaptionText(rawText: string): { speaker?: string; text: string } {
  const text = normalizeText(rawText);
  const separatorMatch = text.match(/^(.{1,80}?)(?:[:：]|\s{2,}| - | — )(.{1,})$/);
  if (separatorMatch) {
    const speaker = normalizeText(separatorMatch[1]);
    const body = normalizeText(separatorMatch[2]);
    if (speaker && body && speaker.toLowerCase() !== body.toLowerCase() && !isLikelyControlText(speaker)) return { speaker, text: body };
  }

  const words = text.split(" ");
  if (words.length >= 4) {
    const maybeSpeaker = words.slice(0, 2).join(" ");
    const body = words.slice(2).join(" ");
    const looksLikeName = /^[\p{L}.'-]+\s+[\p{L}.'-]+$/u.test(maybeSpeaker);
    if (looksLikeName && body.length > 8) return { speaker: maybeSpeaker, text: body };
  }

  return { text };
}


function isPotentialCaptionText(rawText: string, split: { speaker?: string; text: string }, source: string): boolean {
  const text = normalizeText(split.text);
  if (!text || text.length < 3 || isLikelyControlText(text)) return false;
  if (source === "bottom-visible") return false;

  const lower = text.toLowerCase();
  if (["english", "devices"].includes(lower)) return false;
  if (/^(?:[\p{L}.'-]+\s*){1,3}$/u.test(text) && text.length < 40) return false;

  const words = text.split(" ").filter(Boolean);
  if (words.length <= 2 && !/[.!?]/.test(text)) return false;

  const midpoint = Math.floor(words.length / 2);
  if (words.length % 2 === 0 && midpoint > 0) {
    const first = words.slice(0, midpoint).join(" ").toLowerCase();
    const second = words.slice(midpoint).join(" ").toLowerCase();
    if (first === second) return false;
  }

  // Prefer Meet caption/live regions. This intentionally keeps false positives out
  // of captions[] while candidates[] still helps debug selector drift.
  return source !== "bottom-visible";
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
