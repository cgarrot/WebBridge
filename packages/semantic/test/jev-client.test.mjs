// Unit tests for JevClient against a local mock HTTP server.
// Run: cd packages/semantic && npm test   (requires `pnpm build` first)

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { JevClient } from "../dist/jev/client.js";

const QUESTIONS = {
  alive: { type: "noul", instructions: "Is the state non-empty" },
};

function startMock(handler) {
  return new Promise((resolve) => {
    let hits = 0;
    const server = http.createServer((req, res) => {
      hits++;
      handler(req, res, hits);
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}`, hits: () => hits });
    });
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
  });
}

const OK_BODY = JSON.stringify({
  model: "jev-mock",
  answers: { alive: { type: "noul", noul: 0.9 } },
  usage: { input_tokens: 42, output_tokens: 7 },
});

test("ok path: parses answers, usage, model", async () => {
  const mock = await startMock((req, res) => res.writeHead(200, { "Content-Type": "application/json" }).end(OK_BODY));
  try {
    const client = new JevClient({ apiKey: "k", baseUrl: mock.baseUrl, timeoutMs: 1000 });
    const result = await client.ask("hello state", QUESTIONS);
    assert.equal(result.ok, true);
    assert.equal(result.cached, false);
    assert.equal(result.answers.alive.noul, 0.9);
    assert.equal(result.usage.input_tokens, 42);
    assert.equal(result.model, "jev-mock");
  } finally {
    mock.server.close();
  }
});

test("cache: identical ask is served from cache (single server hit)", async () => {
  const mock = await startMock((req, res) => res.writeHead(200).end(OK_BODY));
  try {
    const client = new JevClient({ apiKey: "k", baseUrl: mock.baseUrl, timeoutMs: 1000 });
    const first = await client.ask("same state", QUESTIONS);
    const second = await client.ask("same state", QUESTIONS);
    assert.equal(first.ok && first.cached, false);
    assert.equal(second.ok && second.cached, true);
    assert.equal(second.ok && second.tookMs, 0);
    assert.equal(mock.hits(), 1);
    // Different state must not hit the cache.
    const third = await client.ask("different state", QUESTIONS);
    assert.equal(third.ok && third.cached, false);
    assert.equal(mock.hits(), 2);
  } finally {
    mock.server.close();
  }
});

test("4xx: no retry, single attempt, error surfaced", async () => {
  const mock = await startMock((req, res) => res.writeHead(401).end('{"error":"invalid key"}'));
  try {
    const client = new JevClient({ apiKey: "bad", baseUrl: mock.baseUrl, timeoutMs: 1000 });
    const result = await client.ask("state", QUESTIONS);
    assert.equal(result.ok, false);
    assert.match(result.error, /api_401/);
    assert.equal(mock.hits(), 1);
  } finally {
    mock.server.close();
  }
});

test("network error: retries exactly once, then succeeds", async () => {
  const mock = await startMock((req, res, hits) => {
    if (hits === 1) {
      res.socket?.destroy();
      return;
    }
    res.writeHead(200).end(OK_BODY);
  });
  try {
    const client = new JevClient({ apiKey: "k", baseUrl: mock.baseUrl, timeoutMs: 1000 });
    const result = await client.ask("state", QUESTIONS);
    assert.equal(result.ok, true);
    assert.equal(mock.hits(), 2);
  } finally {
    mock.server.close();
  }
});

test("timeout: aborts within budget, no retry, ok:false", async () => {
  const mock = await startMock((req, res) => setTimeout(() => res.writeHead(200).end(OK_BODY), 500));
  try {
    const client = new JevClient({ apiKey: "k", baseUrl: mock.baseUrl, timeoutMs: 60 });
    const started = Date.now();
    const result = await client.ask("state", QUESTIONS);
    assert.equal(result.ok, false);
    assert.equal(result.error, "timeout");
    assert.ok(Date.now() - started < 450, `took too long: ${Date.now() - started}ms`);
    assert.equal(mock.hits(), 1); // timeouts never retry
  } finally {
    mock.server.close();
  }
});

test("no api key: disabled, zero requests", async () => {
  const mock = await startMock((req, res) => res.writeHead(200).end(OK_BODY));
  try {
    const client = new JevClient({ baseUrl: mock.baseUrl });
    assert.equal(client.disabled, true);
    const result = await client.ask("state", QUESTIONS);
    assert.equal(result.ok, false);
    assert.equal(result.error, "no_api_key");
    assert.equal(mock.hits(), 0);
  } finally {
    mock.server.close();
  }
});

test("empty questions: refused without request", async () => {
  const mock = await startMock((req, res) => res.writeHead(200).end(OK_BODY));
  try {
    const client = new JevClient({ apiKey: "k", baseUrl: mock.baseUrl });
    const result = await client.ask("state", {});
    assert.equal(result.ok, false);
    assert.equal(result.error, "no_questions");
    assert.equal(mock.hits(), 0);
  } finally {
    mock.server.close();
  }
});
