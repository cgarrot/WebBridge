// JevClient — thin, defensive client for the TypeSafe System One API.
//
// Contract (https://docs.typesafe.ai/introduction/quickstart):
//   POST {baseUrl}/v1/systemone
//   Authorization: Bearer <key>
//   { "state": string|object, "model": string, "questions": { [id]: {type, instructions, criteria?} } }
//   → { "model": string, "answers": { [id]: {type, ...typed values, probabilities?, confidence?} },
//       "usage": { input_tokens, output_tokens } }
//
// Hard rules:
//   - NEVER throws. Every failure path returns { ok:false, error }.
//   - Timeouts do not retry (the timeout IS the latency budget).
//   - Network errors retry exactly once.
//   - 4xx responses do not retry (client-side problem: auth, schema, ...).
//   - Answers are cached (canonical state+questions hash, TTL 10 min) so
//     re-verification loops in flows don't re-pay latency or tokens.

import { LruCache, stableHash } from "./cache.js";
import type { JevAnswer, JevAskResult, JevQuestion, JevState, Logger } from "../types.js";

export const JEV_DEFAULT_MODEL = "jev-latest";
export const JEV_DEFAULT_BASE_URL = "https://api.typesafe.ai";
export const JEV_DEFAULT_TIMEOUT_MS = 3000;
const JEV_CACHE_MAX_ENTRIES = 200;
const JEV_CACHE_TTL_MS = 10 * 60 * 1000;

export interface JevClientOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  log?: Logger;
  /** Test hook. Defaults to global fetch (Node >= 18). */
  fetchImpl?: typeof fetch;
}

export interface JevLastCall {
  ok: boolean;
  tookMs: number;
  at: string;
  questions: number;
  cached: boolean;
  error?: string;
}

export class JevClient {
  readonly model: string;
  readonly disabled: boolean;

  private cache = new LruCache<Record<string, JevAnswer>>(
    JEV_CACHE_MAX_ENTRIES,
    JEV_CACHE_TTL_MS
  );
  private lastCall: JevLastCall | null = null;

  constructor(private readonly opts: JevClientOptions) {
    this.model = opts.model ?? JEV_DEFAULT_MODEL;
    this.disabled = !opts.apiKey;
  }

  getLastCall(): JevLastCall | null {
    return this.lastCall;
  }

  clearCache(): void {
    this.cache.clear();
  }

  async ask(
    state: JevState,
    questions: Record<string, JevQuestion>
  ): Promise<JevAskResult> {
    const started = Date.now();
    const questionCount = questions ? Object.keys(questions).length : 0;

    if (this.disabled) {
      return { ok: false, error: "no_api_key", tookMs: 0 };
    }
    if (questionCount === 0) {
      return { ok: false, error: "no_questions", tookMs: 0 };
    }

    const cacheKey = stableHash({ m: this.model, s: state, q: questions });
    const cachedAnswers = this.cache.get(cacheKey);
    if (cachedAnswers) {
      this.lastCall = {
        ok: true, tookMs: 0, at: new Date().toISOString(),
        questions: questionCount, cached: true,
      };
      return { ok: true, answers: cachedAnswers, model: this.model, tookMs: 0, cached: true };
    }

    const doFetch = this.opts.fetchImpl ?? fetch;
    const baseUrl = (this.opts.baseUrl ?? JEV_DEFAULT_BASE_URL).replace(/\/+$/, "");
    const timeoutMs = this.opts.timeoutMs ?? JEV_DEFAULT_TIMEOUT_MS;

    let lastError = "network_error";
    let attempts = 0;
    while (attempts < 2) {
      attempts++;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await doFetch(`${baseUrl}/v1/systemone`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.opts.apiKey}`,
          },
          body: JSON.stringify({ state, model: this.model, questions }),
          signal: controller.signal,
        });

        if (!res.ok) {
          const body = await res.text().catch(() => "");
          const error = `api_${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`;
          this.record(error, questionCount, started, false);
          // 4xx/5xx: no retry — deterministic server-side verdict.
          return { ok: false, error, tookMs: Date.now() - started };
        }

        const json = (await res.json()) as {
          model?: string;
          answers?: Record<string, JevAnswer>;
          usage?: { input_tokens?: number; output_tokens?: number };
        };
        const answers = json.answers ?? {};
        this.cache.set(cacheKey, answers);
        const tookMs = Date.now() - started;
        this.record(undefined, questionCount, started, false, true);
        this.opts.log?.(
          `[jev] q=${questionCount} took=${tookMs}ms cached=0 tokens=${json.usage?.input_tokens ?? "?"}/${json.usage?.output_tokens ?? "?"}`
        );
        return { ok: true, answers, model: json.model, tookMs, cached: false, usage: json.usage };
      } catch (err) {
        const isAbort = err instanceof Error && err.name === "AbortError";
        lastError = isAbort ? "timeout" : err instanceof Error ? err.message : String(err);
        if (isAbort) break; // timeout consumed the budget — do not retry
        // network error → single retry
      } finally {
        clearTimeout(timer);
      }
    }

    this.record(lastError, questionCount, started, false);
    return { ok: false, error: lastError, tookMs: Date.now() - started };
  }

  private record(
    error: string | undefined,
    questions: number,
    started: number,
    cached: boolean,
    ok = false
  ): void {
    this.lastCall = {
      ok,
      tookMs: Date.now() - started,
      at: new Date().toISOString(),
      questions,
      cached,
      ...(error ? { error } : {}),
    };
  }
}
