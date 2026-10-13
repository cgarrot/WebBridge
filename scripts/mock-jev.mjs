#!/usr/bin/env node
// Mock TypeSafe (Jev) API server for local testing of the semantic feature.
// Mirrors POST /v1/systemone: generates a type-appropriate answer per question.
//
// Usage:
//   node scripts/mock-jev.mjs [--port 4111]
// Then start the daemon with:
//   WEBBRIDGE_SEMANTIC_ENABLED=1 TYPESAFE_API_KEY=mock \
//   WEBBRIDGE_JEV_BASE_URL=http://127.0.0.1:4111 node packages/daemon/dist/index.js

import http from "node:http";

const args = process.argv.slice(2);
const portFlag = args.indexOf("--port");
const PORT = portFlag !== -1 ? Number(args[portFlag + 1]) : 4111;

function answerFor(question) {
  if (question?.type === "choice") {
    const criteria = question.criteria;
    let first;
    if (criteria && typeof criteria === "object" && !Array.isArray(criteria)) {
      // Prefer a real option over the __none__ escape hatch.
      first = Object.keys(criteria).find((k) => k !== "__none__");
    } else if (Array.isArray(criteria) && criteria.length) {
      first = String(criteria[0]);
    }
    first = first ?? "option_1";
    return {
      type: "choice",
      choice: first,
      confidence: 0.9,
      probabilities: { [first]: 0.9, other: 0.1 },
    };
  }
  if (question?.type === "score") {
    return { type: "score", score: 1, confidence: 0.8, probabilities: { "0": 0.1, "1": 0.8, "2": 0.1 } };
  }
  return { type: "noul", noul: 0.9 };
}

const server = http.createServer((req, res) => {
  if (req.method !== "POST" || !req.url.startsWith("/v1/systemone")) {
    res.writeHead(404).end(JSON.stringify({ error: "not found" }));
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let parsed = {};
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400).end(JSON.stringify({ error: "bad json" }));
      return;
    }
    const questions = parsed.questions ?? {};
    const answers = {};
    for (const [key, question] of Object.entries(questions)) {
      answers[key] = answerFor(question);
    }
    const qCount = Object.keys(questions).length;
    console.log(`[mock-jev] POST model=${parsed.model} questions=${qCount} state_bytes=${body.length}`);
    res.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        model: "jev-mock",
        answers,
        usage: { input_tokens: 100 * qCount, output_tokens: 10 * qCount },
      })
    );
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[mock-jev] listening on http://127.0.0.1:${PORT}/v1/systemone`);
});
