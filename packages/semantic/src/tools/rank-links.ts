// rank_links — semantic link ranking (Layer 1 discovery).
//
// Replaces "extract_links → agent reads 20-40 links → agent reasons about
// which to follow (and which are promoted/sponsored) → navigate" with ONE
// daemon-side call. ONE Jev request carries ALL questions (fan-out):
//   - rel_i  : Score per link  [irrelevant | related | exact match]
//   - promo_i: Noul per link   (promoted/sponsored/recommended vs organic)
// Parallel evaluation → near-constant latency regardless of link count
// (TypeSafe speculative fan-out pattern).

import type { JevClient } from "../jev/client.js";
import type { JevQuestion, SideToolHandler } from "../types.js";
import { resolveAgentTab } from "./agent-tab.js";

export interface ExtractLinksResult {
  url?: string;
  title?: string;
  links?: Array<{ text?: string; href?: string; ariaLabel?: string }>;
  count?: number;
  matched?: number;
  totalCandidates?: number;
  truncated?: boolean;
}

const SCORE_LEGEND = ["irrelevant", "related", "exact match"];
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;
const DEFAULT_CONSIDERED = 30;
const MAX_CONSIDERED = 40;
const MAX_TEXT = 90;
const PROMO_THRESHOLD = 0.6;

const truncate = (s: string, max: number) =>
  s.length > max ? s.slice(0, max) : s;

export function createRankLinksTool(jev: JevClient): SideToolHandler {
  return async (args, call) => {
    const intent =
      typeof args.intent === "string" ? args.intent.trim() : "";
    if (!intent) {
      throw new Error("rank_links: intent is required (e.g. \"the official pricing page\")");
    }
    const tabId =
      typeof args.tabId === "number" ? args.tabId : await resolveAgentTab(call);
    const limit = Math.min(
      Math.max(typeof args.limit === "number" ? args.limit : DEFAULT_LIMIT, 1),
      MAX_LIMIT
    );
    const considered = Math.min(
      typeof args.maxConsidered === "number" ? args.maxConsidered : DEFAULT_CONSIDERED,
      MAX_CONSIDERED
    );

    const extractArgs: Record<string, unknown> = {
      limit: considered,
      maxTextLength: MAX_TEXT,
      ...(args.selector ? { selector: args.selector } : {}),
      ...(args.hrefIncludes ? { hrefIncludes: args.hrefIncludes } : {}),
      ...(args.hrefExcludes ? { hrefExcludes: args.hrefExcludes } : {}),
      ...(args.textIncludes ? { textIncludes: args.textIncludes } : {}),
      ...(args.textExcludes ? { textExcludes: args.textExcludes } : {}),
      ...(tabId !== undefined ? { tabId } : {}),
    };
    const extracted = (await call("extract_links", extractArgs)) as ExtractLinksResult;
    const links = (extracted?.links ?? []).filter(
      (l) => typeof l?.href === "string" && l.href.length > 0
    );
    if (links.length === 0) {
      return {
        ok: false,
        error: "no_links",
        hint: "extract_links returned no links with the given filters; widen filters or check the page.",
      };
    }

    const numbered = links.map((l, i) => ({
      i,
      text: truncate(l.text ?? l.ariaLabel ?? "", MAX_TEXT),
      href: truncate(l.href!, 160),
    }));

    // ONE fan-out call: 2 questions per link, all parallel.
    const questions: Record<string, JevQuestion> = {};
    for (const l of numbered) {
      questions[`rel_${l.i}`] = {
        type: "score",
        instructions: {
          question: `How relevant is \`links[${l.i}]\` (text "${l.text}", href "${l.href}") to the intent \`${intent}\`?`,
          focus:
            "exact match = the link most people would follow for this intent; related = same topic but not the primary target; irrelevant = different topic.",
        },
        criteria: SCORE_LEGEND,
      };
      questions[`promo_${l.i}`] = {
        type: "noul",
        instructions: {
          question: `Is \`links[${l.i}]\` promoted, sponsored, or algorithmically recommended content rather than an organic result?`,
          focus:
            'Signals: labels like "Sponsored", "Ad", "Promoted", "Featured", "Recommended for you", affiliate tiles above the main list.',
        },
      };
    }

    const result = await jev.ask(
      { intent, page: { url: extracted?.url, title: extracted?.title }, links: numbered },
      questions
    );

    if (!result.ok) {
      return {
        ok: true,
        fallback: true,
        reason: "jev_unavailable",
        error: result.error,
        links: numbered.slice(0, limit),
        hint: "Jev unavailable — raw (unranked) links returned.",
      };
    }

    const answers = result.answers;
    const ranked = numbered
      .map((l) => {
        const rel = answers[`rel_${l.i}`];
        const promo = answers[`promo_${l.i}`];
        const probabilities = rel?.probabilities ?? {};
        return {
          text: l.text,
          href: l.href,
          relevance: rel ? SCORE_LEGEND[Math.round(rel.score ?? 0)] : undefined,
          score: rel?.score ?? null,
          p_exact: probabilities["2"] ?? 0,
          p_related: probabilities["1"] ?? 0,
          promoted: promo ? promo.noul !== undefined && promo.noul >= PROMO_THRESHOLD : false,
          p_promoted: promo?.noul ?? null,
          confidence: rel?.confidence ?? null,
        };
      })
      .sort((a, b) => b.p_exact - a.p_exact || b.p_related - a.p_related);

    const top = ranked.slice(0, limit);
    return {
      ok: true,
      intent,
      url: extracted?.url,
      considered: numbered.length,
      truncatedUpstream: extracted?.truncated ?? false,
      links: top,
      top_organic: ranked.filter((l) => !l.promoted).slice(0, 3).map((l) => l.href),
      tookMs: result.tookMs,
      cached: result.cached,
    };
  };
}
