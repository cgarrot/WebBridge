// page_triage — one-call page state verdict (Layer 1 discovery).
//
// The agent's first call after navigate can be a single decision-ready
// verdict instead of screenshot + extract + reasoning. ONE Jev call, Noul
// fan-out (speculative: every flag evaluated in parallel over the same
// bounded page text):
//   needs_login, has_paywall, has_captcha, has_cookie_banner,
//   content_loaded, is_error_page   + optional relevance Score vs intent.

import type { JevClient } from "../jev/client.js";
import type { JevQuestion, SideToolHandler } from "../types.js";
import { resolveAgentTab } from "./agent-tab.js";

interface ExtractTextResult {
  url?: string;
  title?: string;
  text?: string;
  chars?: number;
  truncated?: boolean;
}

const RELEVANCE_LEGEND = ["unrelated", "topical", "directly relevant"];
const BLOCKER_THRESHOLD = 0.6;
const CONTENT_OK_THRESHOLD = 0.5;
const MIN_MAIN_CHARS = 40;

export function createPageTriageTool(jev: JevClient): SideToolHandler {
  return async (args, call) => {
    const intent =
      typeof args.intent === "string" ? args.intent.trim() : "";
    const tabId =
      typeof args.tabId === "number" ? args.tabId : await resolveAgentTab(call);
    const tabArg = tabId !== undefined ? { tabId } : {};

    // Prefer semantic content regions; fall back to whole body when empty
    // (login walls and error pages often have no <main>).
    let extracted = (await call("extract_text", {
      selectors: ["main", "article"],
      maxChars: 3000,
      ...tabArg,
    })) as ExtractTextResult;
    if ((extracted?.chars ?? 0) < MIN_MAIN_CHARS) {
      extracted = (await call("extract_text", {
        maxChars: 3000,
        ...tabArg,
      })) as ExtractTextResult;
    }

    const text = extracted?.text ?? "";
    if (text.trim().length === 0) {
      return {
        ok: false,
        error: "no_page_text",
        url: extracted?.url,
        hint: "extract_text returned nothing — the tab may be on a chrome:// page, still loading, or crashed. wait_for then retry.",
      };
    }

    const state: Record<string, unknown> = {
      page: { url: extracted?.url, title: extracted?.title },
      text,
    };
    if (intent) state.intent = intent;

    const questions: Record<string, JevQuestion> = {
      needs_login: {
        type: "noul",
        instructions: {
          question: "Is the page's primary content hidden behind a login requirement or sign-in wall?",
          inspect: "`text`",
          focus: "A visible sign-in FORM alone is not a wall; require content withheld pending authentication.",
        },
      },
      has_paywall: {
        type: "noul",
        instructions: {
          question: "Is the content restricted by a paywall or subscription prompt?",
          inspect: "`text`",
          focus: 'Phrases like "subscribe to continue reading", metered quota, members-only.',
        },
      },
      has_captcha: {
        type: "noul",
        instructions: {
          question: "Is the page showing a CAPTCHA or bot verification challenge?",
          inspect: "`text`",
          focus: "Verification challenge blocking normal use, not a normal login form.",
        },
      },
      has_cookie_banner: {
        type: "noul",
        instructions: {
          question: "Is a cookie consent banner or GDPR dialog prominently displayed?",
          inspect: "`text`",
          focus: "Consent prompt for cookies/tracking, typically with accept/reject buttons.",
        },
      },
      content_loaded: {
        type: "noul",
        instructions: {
          question: "Does the page's main content appear fully loaded (not a blank shell or spinner-only page)?",
          inspect: "`text`",
          focus: "Meaningful readable content is present beyond navigation and boilerplate.",
        },
      },
      is_error_page: {
        type: "noul",
        instructions: {
          question: "Is this an error page (404, 500, not found, access denied)?",
          inspect: "`text`",
        },
      },
    };
    if (intent) {
      questions.relevance = {
        type: "score",
        instructions: {
          question: `How relevant is \`text\` to the intent \`${intent}\`?`,
          focus:
            "directly relevant = the page addresses the intent; topical = same subject, not the target; unrelated = different subject.",
        },
        criteria: RELEVANCE_LEGEND,
      };
    }

    const result = await jev.ask(state, questions);

    if (!result.ok) {
      return {
        ok: true,
        fallback: true,
        reason: "jev_unavailable",
        error: result.error,
        url: extracted?.url,
        title: extracted?.title,
        text_preview: text.slice(0, 300),
        hint: "Jev unavailable — raw preview returned; triage manually.",
      };
    }

    const n = (name: string): number => {
      const v = result.answers[name]?.noul;
      return typeof v === "number" ? v : 0;
    };

    const hardBlockers: string[] = [];
    if (n("needs_login") >= BLOCKER_THRESHOLD) hardBlockers.push("needs_login");
    if (n("has_paywall") >= BLOCKER_THRESHOLD) hardBlockers.push("has_paywall");
    if (n("has_captcha") >= BLOCKER_THRESHOLD) hardBlockers.push("has_captcha");
    if (n("is_error_page") >= BLOCKER_THRESHOLD) hardBlockers.push("is_error_page");

    const contentOk = n("content_loaded") >= CONTENT_OK_THRESHOLD;
    if (!contentOk) hardBlockers.push("content_missing");

    const annoyances: string[] = [];
    if (n("has_cookie_banner") >= BLOCKER_THRESHOLD) annoyances.push("cookie_banner");

    const rel = result.answers.relevance;
    const payload: Record<string, unknown> = {
      ok: true,
      url: extracted?.url,
      title: extracted?.title,
      usable: hardBlockers.length === 0,
      blockers: hardBlockers,
      annoyances,
      flags: {
        needs_login: n("needs_login"),
        has_paywall: n("has_paywall"),
        has_captcha: n("has_captcha"),
        has_cookie_banner: n("has_cookie_banner"),
        content_loaded: n("content_loaded"),
        is_error_page: n("is_error_page"),
      },
      tookMs: result.tookMs,
      cached: result.cached,
    };
    if (rel) {
      payload.relevance = {
        label: RELEVANCE_LEGEND[Math.round(rel.score ?? 0)],
        score: rel.score ?? null,
        confidence: rel.confidence ?? null,
      };
    }
    return payload as Record<string, unknown>;
  };
}
