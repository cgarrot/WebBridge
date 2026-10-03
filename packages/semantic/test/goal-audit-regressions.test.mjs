// B2 — tests de non-régression sur les défauts reproduits par l'audit Viso
// (reports/viso-system-audit-2026-09-19/offline-probes.mjs, sondes P01/P02/P03).
//
// Ces tests portent sur le paquet `semantic` SEUL : aucun daemon, aucun
// navigateur, aucun réseau (fetch est injecté).
//
// Run: cd packages/semantic && npm run build && npm test

import test from "node:test";
import assert from "node:assert/strict";

import { createTextHelper } from "../dist/goal/text-helper.js";
import { authorizeGoalAction } from "../dist/goal/safety.js";
import { GoalRunner } from "../dist/goal/loop.js";
import { actionTargetGuard } from "../dist/goal/action-space.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const FIELD_CONTEXT = {
  goal: "remplis le champ",
  field: { label: "Email", role: "textbox" },
  page: { title: "Formulaire", text: "..." },
  recent_actions: [],
};

/** Réponse complète et valide du helper, réutilisée par les cas nominaux. */
const OK_BODY = { choices: [{ message: { content: '{"text":"ok"}' } }], usage: { total_tokens: 5 } };

// ---------------------------------------------------------------------------
// P01 — le délai doit couvrir la LECTURE DU CORPS, pas seulement les headers.
//
// Avant le correctif : `clearTimeout(timer)` était appelé dès que les headers
// arrivaient, donc un serveur qui envoie ses headers puis ne termine jamais son
// corps faisait attendre le but indéfiniment (la sonde mesurait un signal
// toujours non avorté 45 ms après un délai configuré à 10 ms).
// ---------------------------------------------------------------------------

test("P01 : un corps qui ne finit jamais est interrompu par le délai", async () => {
  let aborted = false;
  const helper = createTextHelper({ apiKey: "k", timeoutMs: 40 }, async (_url, opts) => {
    // Headers immédiats, corps qui ne se résout JAMAIS.
    return {
      ok: true,
      status: 200,
      json: () =>
        new Promise((_resolve, reject) => {
          opts.signal.addEventListener("abort", () => {
            aborted = true;
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        }),
    };
  });

  const started = Date.now();
  const result = await helper(FIELD_CONTEXT);
  const elapsed = Date.now() - started;

  assert.equal(result.ok, false, "un corps qui ne finit jamais ne doit pas produire de succès");
  assert.match(result.error, /text_helper_timeout/, `erreur attendue de type timeout, reçue: ${result.error}`);
  assert.equal(aborted, true, "le signal doit être avorté quand le corps dépasse le délai");
  assert.ok(elapsed < 2000, `le retour doit être borné (mesuré ${elapsed} ms pour un délai de 40 ms)`);
});

test("P01 : un corps lent mais complet dans le délai reste un succès", async () => {
  const helper = createTextHelper({ apiKey: "k", timeoutMs: 500 }, async (_url, opts) => ({
    ok: true,
    status: 200,
    json: async () => {
      await sleep(30);
      assert.equal(opts.signal.aborted, false, "le délai ne doit pas avoir été atteint");
      return OK_BODY;
    },
  }));

  const result = await helper(FIELD_CONTEXT);
  assert.equal(result.ok, true, `succès attendu, reçu: ${JSON.stringify(result)}`);
  assert.equal(result.text, "ok");
});

test("P01 : le délai est partagé entre requête et corps (pas doublé)", async () => {
  // 60 ms de headers + un corps qui ne finit pas, pour un délai de 120 ms :
  // le budget total doit rester ~120 ms, pas 120 + 120.
  const helper = createTextHelper({ apiKey: "k", timeoutMs: 120 }, async (_url, opts) => {
    await sleep(60);
    return {
      ok: true,
      status: 200,
      json: () =>
        new Promise((_resolve, reject) => {
          opts.signal.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        }),
    };
  });

  const started = Date.now();
  const result = await helper(FIELD_CONTEXT);
  const elapsed = Date.now() - started;
  assert.equal(result.ok, false);
  assert.ok(elapsed < 400, `budget total respecté (mesuré ${elapsed} ms, budget 120 ms)`);
});

test("P01 : un timeout de requête garde son message d'origine", async () => {
  const helper = createTextHelper({ apiKey: "k", timeoutMs: 30 }, async () => {
    const error = new Error("The operation was aborted");
    error.name = "AbortError";
    throw error;
  });
  const result = await helper(FIELD_CONTEXT);
  assert.equal(result.ok, false);
  assert.match(result.error, /text_helper_failed/);
});

test("P01 : sans clé, le helper n'appelle jamais le réseau", async () => {
  let calls = 0;
  const helper = createTextHelper({ apiKey: "" }, async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => OK_BODY };
  });
  const result = await helper(FIELD_CONTEXT);
  assert.equal(calls, 0);
  assert.equal(result.ok, false);
  assert.match(result.error, /text_helper_unavailable/);
});

// ---------------------------------------------------------------------------
// P02 — le contrat de but (côté Viso, mais l'audit le classait avec la sécurité)
// est testé dans agent_viso_v2 : `src/agent/goal-contract.ts`, fail-closed sur
// « unclear ». Ici on vérifie la MOITIÉ WebBridge de la même règle : le gate
// d'effet ne doit jamais transformer un doute en autorisation.
// ---------------------------------------------------------------------------

test("P02b : un « unclear » côté gate d'effet est refusé (authorization_uncertain)", async () => {
  const result = await authorizeGoalAction(
    {
      ask: async () => ({
        ok: true,
        answers: {
          effect: {
            choice: "unknown",
            confidence: 0.9,
            probabilities: { browse: 0.1, edit: 0.05, cart: 0.05, commit: 0.1, sensitive: 0.1, unknown: 0.6 },
          },
        },
      }),
    },
    {
      goal: "prépare le panier",
      url: "https://shop.example/p/x",
      action: { id: "a1", kind: "click", label: "Continue" },
      safety: { version: 1, allowedOrigins: ["https://shop.example"], allowCart: true },
    }
  );
  assert.equal(result.ok, false, `un doute ne doit pas autoriser (reçu ${JSON.stringify(result)})`);
  assert.equal(result.reason, "authorization_uncertain");
});

test("P02c : commit et sensitive sont refusés même avec une forte confiance", async () => {
  for (const choice of ["commit", "sensitive"]) {
    const result = await authorizeGoalAction(
      {
        ask: async () => ({
          ok: true,
          answers: {
            effect: {
              choice,
              confidence: 0.99,
              probabilities: Object.fromEntries(
                ["browse", "edit", "cart", "commit", "sensitive", "unknown"].map((id) => [id, id === choice ? 0.95 : 0.01])
              ),
            },
          },
        }),
      },
      {
        goal: "lis la page",
        url: "https://shop.example/p/x",
        action: { id: "a1", kind: "click", label: "Continue" },
        safety: { version: 1, allowedOrigins: ["https://shop.example"], allowCart: false },
      }
    );
    assert.equal(result.ok, false, `${choice} ne doit pas être autorisé`);
    assert.equal(result.reason, `effect_${choice}`);
  }
});

test("P02d : un libellé de paiement est refusé par le refus dur, avant toute inférence", async () => {
  let asked = 0;
  const result = await authorizeGoalAction(
    { ask: async () => { asked += 1; return { ok: true, answers: {} }; } },
    {
      goal: "lis la page",
      url: "https://shop.example/p/x",
      action: { id: "a1", kind: "click", label: "Passer la commande" },
      safety: { version: 1, allowedOrigins: ["https://shop.example"], allowCart: true },
    }
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "requires_explicit_approval");
  assert.equal(asked, 0, "le refus dur ne doit même pas interroger le modèle");
});

test("P02e : une action hors origine autorisée est refusée", async () => {
  const result = await authorizeGoalAction(
    { ask: async () => ({ ok: true, answers: { effect: { choice: "browse", confidence: 0.9, probabilities: { browse: 0.9, edit: 0.02, cart: 0.02, commit: 0.02, sensitive: 0.02, unknown: 0.02 } } } }) },
    {
      goal: "lis la page",
      url: "https://evil.example/p/x",
      action: { id: "a1", kind: "click", label: "Continue" },
      safety: { version: 1, allowedOrigins: ["https://shop.example"], allowCart: false },
    }
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "outside_allowed_origin");
});

// ---------------------------------------------------------------------------
// P03 — la masse d'une classe NON AUTORISÉE ne doit pas disparaître.
//
// Sonde : `browse .4 / edit .2 / cart .4` avec `allowCart:false` était ACCEPTÉ.
// safeMass valait .6 et riskMass 0 : la croyance de 40 % portant sur une action
// pour laquelle le bot n'a AUCUNE autorité était ignorée.
// ---------------------------------------------------------------------------

const EFFECT_KEYS = ["browse", "edit", "cart", "commit", "sensitive", "unknown"];
const probModel = (probs) => ({
  ask: async () => ({
    ok: true,
    answers: {
      effect: {
        choice: Object.entries(probs).sort((a, b) => b[1] - a[1])[0][0],
        confidence: probs[Object.entries(probs).sort((a, b) => b[1] - a[1])[0][0]],
        probabilities: Object.fromEntries(EFFECT_KEYS.map((id) => [id, probs[id] ?? 0])),
      },
    },
  }),
});

const CART_DENIED = { version: 1, allowedOrigins: ["https://shop.example"], allowCart: false };
const CART_ALLOWED = { version: 1, allowedOrigins: ["https://shop.example"], allowCart: true };
const READ_ACTION = { id: "a1", kind: "click", label: "Continue" };

test("P03 : masse panier significative sans autorité -> refus", async () => {
  const result = await authorizeGoalAction(probModel({ browse: 0.4, edit: 0.2, cart: 0.4 }), {
    goal: "lis la page",
    url: "https://shop.example/p/x",
    action: READ_ACTION,
    safety: CART_DENIED,
  });
  assert.equal(result.ok, false, `le panier non autorisé ne doit pas être ignoré (reçu ${JSON.stringify(result)})`);
  assert.match(result.reason, /unauthorized_cart_mass|risk_mass|ambiguous/);
});

test("P03 : masses égales .4/.4 -> refus (aucune classe ne domine)", async () => {
  const result = await authorizeGoalAction(probModel({ browse: 0.4, cart: 0.4, edit: 0.1, unknown: 0.1 }), {
    goal: "lis la page",
    url: "https://shop.example/p/x",
    action: READ_ACTION,
    safety: CART_DENIED,
  });
  assert.equal(result.ok, false, "à masse égale, on ne choisit pas l'action interdite");
});

test("P03 : unknown compte aussi comme risque (l'incertitude n'est pas du sûr)", async () => {
  const result = await authorizeGoalAction(probModel({ browse: 0.45, unknown: 0.4, edit: 0.15 }), {
    goal: "lis la page",
    url: "https://shop.example/p/x",
    action: READ_ACTION,
    safety: CART_DENIED,
  });
  assert.equal(result.ok, false, "une incertitude forte doit refuser");
});

test("P03 : NON-RÉGRESSION — les cas légitimes restent autorisés", async () => {
  // 1. Hésitation interne aux classes sûres (mesure live edit .59 / browse .40).
  const safeSplit = await authorizeGoalAction(probModel({ edit: 0.59, browse: 0.4, unknown: 0.01 }), {
    goal: "lis la page", url: "https://shop.example/p/x", action: READ_ACTION, safety: CART_DENIED,
  });
  assert.equal(safeSplit.ok, true, `le split sûr doit passer (reçu ${JSON.stringify(safeSplit)})`);

  // 2. Panier AUTORISÉ et dominant : passe.
  const cartOk = await authorizeGoalAction(probModel({ cart: 0.6, browse: 0.35, unknown: 0.05 }), {
    goal: "ajoute au panier", url: "https://shop.example/p/x",
    action: { id: "a2", kind: "click", label: "Ajouter au panier" }, safety: CART_ALLOWED,
  });
  assert.equal(cartOk.ok, true, `panier autorisé dominant (reçu ${JSON.stringify(cartOk)})`);

  // 3. Lecture franche : passe.
  const clear = await authorizeGoalAction(probModel({ browse: 0.92, edit: 0.05, unknown: 0.03 }), {
    goal: "lis la page", url: "https://shop.example/p/x", action: READ_ACTION, safety: CART_DENIED,
  });
  assert.equal(clear.ok, true, "lecture franche");
});

test("P03 : un choix « cart » sans autorité est refusé nommément", async () => {
  const result = await authorizeGoalAction(probModel({ cart: 0.9, browse: 0.08, unknown: 0.02 }), {
    goal: "lis la page", url: "https://shop.example/p/x", action: READ_ACTION, safety: CART_DENIED,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "authorization_cart_not_allowed");
});

test("P01 : un corps arrivé hors budget est exploité MAIS signalé (pas caché)", async () => {
  // Décision explicite (revue @agent-f98af5) : on n'jette pas une réponse reçue,
  // mais le dépassement est exposé dans les métadonnées.
  const helper = createTextHelper({ apiKey: "k", timeoutMs: 20 }, async (_url, opts) => ({
    ok: true,
    status: 200,
    json: async () => {
      await sleep(45); // au-delà du délai de 20 ms
      assert.equal(opts.signal.aborted, true, "le signal a bien été avorté après l'échéance");
      return OK_BODY;
    },
  }));
  const result = await helper(FIELD_CONTEXT);
  assert.equal(result.ok, true, "une réponse reçue est exploitée");
  assert.equal(result.meta.timedOut, true, "le dépassement est visible");
  assert.equal(result.meta.timeoutPhase, "body");
  assert.ok(result.meta.tookMs > 20);
});

// ---------------------------------------------------------------------------
// P08 — un `requestId` rejoué doit retrouver le MÊME run, même après restart.
//
// Sonde : le rejeu ne consultait que la carte en mémoire. Après un restart, un
// client qui rejouait son `run_goal` (réponse perdue, retry réseau) obtenait un
// NOUVEAU run — donc une seconde exécution du même objectif sur la même page.
// ---------------------------------------------------------------------------

const P08_CONFIG = {
  jevApiKey: "test", jevModel: "test", jevBaseUrl: "", jevTimeoutMs: 1000,
  jevMinConfidence: 0.5, jevMaxCandidates: 60, goalTriageMinElements: 0,
};

function p08Fixture(goalsDir) {
  const action = { id: "a1", node: "a1", kind: "click", label: "Article", rect: { x: 1, y: 1, w: 30, h: 20 }, role: "link" };
  const jev = {
    disabled: false,
    async ask(_state, qs) {
      return {
        ok: true,
        answers: Object.fromEntries(
          Object.entries(qs).map(([id, q]) => [
            id,
            {
              choice: Object.keys(q.criteria)[0],
              confidence: 0.95,
              probabilities: Object.fromEntries(Object.keys(q.criteria).map((k, i) => [k, i === 0 ? 0.95 : 0.01])),
            },
          ])
        ),
        tookMs: 1,
        cached: false,
      };
    },
  };
  const call = async (name) => {
    if (name === "action_space") {
      return { ok: true, url: "https://example.com", title: "Page", text: "Article", marker: "m1", actions: [action] };
    }
    if (name === "element_info") return { found: true, element: { wbId: "a1" } };
    if (name === "click_element") return { ok: true };
    if (name === "evaluate") return { value: 1 };
    throw new Error(name);
  };
  return { runner: new GoalRunner({ config: P08_CONFIG, jev, goalsDir, sleep: async () => {}, textHelper: async () => ({ ok: false, error: "no_helper" }) }), call };
}

test("P08 : rejeu après restart -> même runId, un seul run", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p08-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const requestId = "req-abc-123";

  const first = p08Fixture(dir);
  const run1 = await first.runner.start(first.call, { goal: "lis la page", tabId: 7, requestId });
  assert.ok(run1.runId, "le premier start crée un run");

  // « Restart » : nouveau GoalRunner, même dossier de runs (donc même disque).
  const second = p08Fixture(dir);
  assert.equal(second.runner.status(run1.runId) !== undefined, true, "l'état doit être relu sur disque");

  const run2 = await second.runner.start(second.call, { goal: "lis la page", tabId: 7, requestId });
  assert.equal(run2.runId, run1.runId, `le rejeu doit retrouver le même run (reçu ${run2.runId} vs ${run1.runId})`);

  // Un seul run sur le disque pour ce requestId.
  const runs = second.runner.listRuns(50).filter((r) => r.requestId === requestId);
  assert.equal(runs.length, 1, `un seul run attendu, ${runs.length} trouvé(s)`);
});

test("P08 : même requestId + demande différente -> goal_request_conflict", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p08b-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const requestId = "req-conflict";

  const first = p08Fixture(dir);
  await first.runner.start(first.call, { goal: "lis la page", tabId: 7, requestId });

  const second = p08Fixture(dir);
  await assert.rejects(
    () => second.runner.start(second.call, { goal: "AUTRE objectif", tabId: 7, requestId }),
    /goal_request_conflict/
  );
  await assert.rejects(
    () => second.runner.start(second.call, { goal: "lis la page", tabId: 9, requestId }),
    /goal_request_conflict/
  );
  await assert.rejects(
    () => second.runner.start(second.call, { goal: "lis la page", tabId: 7, dryRun: true, requestId }),
    /goal_request_conflict/
  );
});

test("P08 : deux starts concurrents du même requestId joignent la même promesse", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p08c-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const requestId = "req-concurrent";
  const { runner, call } = p08Fixture(dir);

  const [a, b] = await Promise.all([
    runner.start(call, { goal: "lis la page", tabId: 7, requestId }),
    runner.start(call, { goal: "lis la page", tabId: 7, requestId }),
  ]);
  assert.equal(a.runId, b.runId, "les deux appels concurrents doivent obtenir le même runId");
  const runs = runner.listRuns(50).filter((r) => r.requestId === requestId);
  assert.equal(runs.length, 1, `un seul run attendu, ${runs.length} trouvé(s)`);
});

test("P08 : un requestId absent n'est jamais dédupliqué", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p08d-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { runner, call } = p08Fixture(dir);
  const a = await runner.start(call, { goal: "lis la page", tabId: 7 });
  const b = await runner.start(call, { goal: "lis la page", tabId: 8 });
  assert.notEqual(a.runId, b.runId, "sans requestId, deux starts restent deux runs");
});

test("P08 : un requestId invalide est refusé", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p08e-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { runner, call } = p08Fixture(dir);
  await assert.rejects(
    () => runner.start(call, { goal: "lis la page", tabId: 7, requestId: "a".repeat(81) }),
    /invalid_goal_request_id/
  );
  await assert.rejects(
    () => runner.start(call, { goal: "lis la page", tabId: 7, requestId: "bad id!" }),
    /invalid_goal_request_id/
  );
});

// ---------------------------------------------------------------------------
// P09 — une reprise sans NOUVEAU contexte doit être refusée.
// P06 — `observation_failed_after_action` (effet inconnu) n'est PAS une hésitation.
// Nit revue — un run relu sur disque encore marqué `running` doit être réconcilié
//            en `paused` (jamais présenté comme actif, jamais relancé seul).
// ---------------------------------------------------------------------------

/**
 * Fixture qui produit une pause déterministe avec la raison demandée.
 * Stub Jev « scripté » comme dans goal-loop.test.mjs : il choisit CLICK puis
 * DONE, et `pauseReason` décide de ce qui interrompt la boucle.
 */
function pauseFixture(goalsDir, { pauseReason }) {
  const action = { id: "a1", node: "a1", kind: "click", label: "Article", rect: { x: 1, y: 1, w: 30, h: 20 }, role: "link" };
  let observationsSeen = 0;
  const answerChoice = (questions, id, choiceId, confidence = 0.9) => {
    const keys = Object.keys(questions[id].criteria);
    if (!keys.includes(choiceId)) throw new Error(`answerChoice: "${choiceId}" not offered by ${id}: ${keys.join(",")}`);
    const others = keys.filter((k) => k !== choiceId);
    const probabilities = {};
    for (const key of keys) probabilities[key] = key === choiceId ? (others.length ? 0.9 : 1) : others.length ? 0.1 / others.length : 0;
    return { type: "choice", choice: choiceId, probabilities, confidence };
  };
  let scriptIndex = 0;
  const jev = {
    disabled: false,
    model: "jev-test",
    async ask(_state, questions) {
      // `low_confidence` : le modèle hésite (confiance sous le plancher) sans
      // rien exécuter — c'est l'hésitation que P06/P09 distinguent d'un effet
      // inconnu. Les autres cas exécutent un CLICK puis terminent.
      const hesitating = pauseReason === "low_confidence";
      // La boucle interroge Jev PLUSIEURS fois par étape (opération + cibles
      // spéculatives). Le discriminant n'est donc pas le nombre d'appels mais le
      // nombre d'OBSERVATIONS : la première décision hésite (pause), les
      // suivantes sont franches, ce qui permet à la reprise d'aboutir.
      scriptIndex += 1;
      const firstDecision = observationsSeen <= 1;
      const step = firstDecision
        ? { operation: "CLICK", click_target: "1" }
        : { operation: "DONE" };
      const confidence = hesitating && firstDecision ? 0.1 : 0.9;
      const answers = {};
      for (const [id, choiceId] of Object.entries(step)) answers[id] = answerChoice(questions, id, choiceId, confidence);
      return { ok: true, answers, model: "jev-test", tookMs: 5, cached: false, usage: { input_tokens: 10, output_tokens: 0 } };
    },
  };
  let observationCount = 0;
  const call = async (name) => {
    if (name === "action_space") {
      observationCount += 1;
      observationsSeen = observationCount;
      // `observation_failed_after_action` : la première observation passe, les
      // suivantes échouent (l'effet de l'action n'est plus observable).
      if (pauseReason === "observation_failed_after_action" && observationCount > 1) return { ok: false, error: "tab gone" };
      return { ok: true, url: "https://example.com", title: "Page", text: "Article", marker: `m${observationCount}`, actions: [action] };
    }
    if (name === "element_info") return { found: true, element: { wbId: "a1" } };
    if (name === "click_element") return { ok: true };
    if (name === "evaluate") return { value: 1 };
    throw new Error(name);
  };
  return {
    runner: new GoalRunner({ config: P08_CONFIG, jev, goalsDir, sleep: async () => {}, textHelper: async () => ({ ok: false, error: "no_helper" }) }),
    call,
  };
}

test("P09 : resume sans hint -> resume_requires_new_context", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p09-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { runner, call } = pauseFixture(dir, { pauseReason: "low_confidence" });
  const started = await runner.start(call, { goal: "lis la page", tabId: 7, maxSteps: 1 });
  const paused = await runner.wait(started.runId, 5000);
  assert.equal(paused.status, "paused", "le run doit être en pause pour tester la reprise");

  for (const hint of [undefined, "", "   "]) {
    await assert.rejects(
      () => runner.resume(call, { runId: started.runId, hint }),
      /resume_requires_new_context/,
      `un hint ${JSON.stringify(hint)} ne doit pas suffire`
    );
  }
});

test("P06 : resume d'un effet inconnu est refusé (observation_failed_after_action)", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p06-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { runner, call } = pauseFixture(dir, { pauseReason: "observation_failed_after_action" });
  const started = await runner.start(call, { goal: "clique sur l'article", tabId: 7, maxSteps: 1 });
  const paused = await runner.wait(started.runId, 5000);
  assert.equal(paused.status, "paused");
  assert.equal(paused.lastPause?.reason, "observation_failed_after_action");

  await assert.rejects(
    () => runner.resume(call, { runId: started.runId, hint: "essaie encore" }),
    /resume_refused_effect_unknown/,
    "un effet inconnu ne doit jamais être repris comme une hésitation"
  );
});

test("P06 : une reprise avec hint sur une hésitation passe et observe FRAIS", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p06b-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { runner, call } = pauseFixture(dir, { pauseReason: "low_confidence" });
  const started = await runner.start(call, { goal: "lis la page", tabId: 7, maxSteps: 1 });
  await runner.wait(started.runId, 5000);
  // SUJET DU TEST : la reprise est ACCEPTÉE (elle ne lève pas), le hint est
  // intégré au but, et le run n'est plus en pause. Le snapshot retourné peut
  // déjà refléter l'état final si la boucle a terminé : on n'asserte donc pas
  // sur `resumed.status` mais sur le but enrichi et sur l'état persisté.
  const resumed = await runner.resume(call, { runId: started.runId, hint: "la page a été précisée : cherche le titre" });
  assert.match(resumed.goal, /\[Hint\] la page a été précisée/);
  const final = await runner.wait(started.runId, 5000);
  assert.notEqual(final.status, "paused", `la reprise ne doit pas re-pauser immédiatement (reçu ${final.status} / ${final.lastPause?.reason})`);
  // Le hint doit aussi avoir été PERSISTÉ (survit à un restart).
  const reloaded = new GoalRunner({ config: P08_CONFIG, jev: { disabled: false, ask: async () => ({ ok: true, answers: {}, tookMs: 0, cached: false }) }, goalsDir: dir, sleep: async () => {}, textHelper: async () => ({ ok: false, error: "x" }) }).status(started.runId);
  assert.match(reloaded.goal, /\[Hint\] la page a été précisée/);
});

test("nit P08 : un run relu sur disque encore 'running' est réconcilié en paused", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p08f-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const requestId = "req-ghost";
  const first = pauseFixture(dir, { pauseReason: "low_confidence" });
  const started = await first.runner.start(first.call, { goal: "lis la page", tabId: 7, requestId });

  // Simule un daemon tué en plein run : le state.json reste marqué `running`.
  const statePath = path.join(dir, started.runId, "state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
  state.status = "running";
  state.lastPause = undefined;
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

  // Nouveau runner (restart) : le rejeu ne doit PAS renvoyer un run « actif ».
  const second = pauseFixture(dir, { pauseReason: "low_confidence" });
  const replay = await second.runner.start(second.call, { goal: "lis la page", tabId: 7, requestId });
  assert.equal(replay.runId, started.runId, "même run");
  assert.equal(replay.status, "paused", `un run fantôme ne doit pas être annoncé actif (reçu ${replay.status})`);
  assert.equal(replay.lastPause?.reason, "daemon_restarted_effect_unknown");
});

// ---------------------------------------------------------------------------
// P10 — la cible d'une action (href / form-action / target) doit être vérifiée
// avant le dispatch : le marker ne la couvre pas, donc un libellé identique
// pointant ailleurs après un re-rendu faisait cliquer la mauvaise destination.
// ---------------------------------------------------------------------------

test("P10 : actionTargetGuard expose la cible, et null quand il n'y en a pas", () => {
  assert.equal(actionTargetGuard({ id: "a1", kind: "click", label: "Continuer", href: "/a" }), "/a\u0000\u0000");
  assert.equal(actionTargetGuard({ id: "a1", kind: "click", label: "X", target_guard: "/a\u0000/act\u0000_self" }), "/a\u0000/act\u0000_self");
  // Pas de cible : scroll/wait ou extension ancienne -> rien à comparer.
  assert.equal(actionTargetGuard({ id: "s1", kind: "scroll", label: "Scroll down" }), null);
  assert.equal(actionTargetGuard(undefined), null);
});

/** Fixture P10 : la cible change ENTRE la décision et le dispatch. */
function guardChangeFixture(goalsDir) {
  const answerChoice = (questions, id, choiceId, confidence = 0.9) => {
    const keys = Object.keys(questions[id].criteria);
    const others = keys.filter((k) => k !== choiceId);
    const probabilities = {};
    for (const key of keys) probabilities[key] = key === choiceId ? (others.length ? 0.9 : 1) : others.length ? 0.1 / others.length : 0;
    return { type: "choice", choice: choiceId, probabilities, confidence };
  };
  let decisionStep = 0;
  const jev = {
    disabled: false,
    model: "jev-test",
    async ask(_state, questions) {
      const script = [
        { operation: "CLICK", click_target: "1" },
        { operation: "DONE" },
        { operation: "DONE" },
      ];
      const step = script[Math.min(decisionStep, script.length - 1)];
      decisionStep += 1;
      const answers = {};
      for (const [id, choiceId] of Object.entries(step)) answers[id] = answerChoice(questions, id, choiceId);
      return { ok: true, answers, model: "jev-test", tookMs: 5, cached: false, usage: { input_tokens: 10, output_tokens: 0 } };
    },
  };
  let observationCount = 0;
  const clicks = [];
  const call = async (name, args) => {
    if (name === "action_space") {
      observationCount += 1;
      // Le LIBELLÉ et le marker restent IDENTIQUES ; seul l'href change.
      // La décision lit la 1re observation ; le guard de cible prend une
      // observation FRAÎCHE juste avant le dispatch -> il voit /produit-b.
      const href = observationCount === 1 ? "/produit-a" : "/produit-b";
      const action = {
        id: "a1", node: "a1", kind: "click", label: "Continuer",
        rect: { x: 1, y: 1, w: 30, h: 20 }, role: "link",
        href, form_action: null, target: null, target_guard: `${href}\u0000\u0000`,
      };
      return { ok: true, url: "https://example.com", title: "Page", text: "Article", marker: "m-constant", actions: [action] };
    }
    if (name === "element_info") return { found: true, element: { wbId: "a1" } };
    if (name === "click_element") {
      clicks.push(args);
      return { ok: true };
    }
    if (name === "evaluate") return { value: 1 };
    throw new Error(name);
  };
  return {
    runner: new GoalRunner({ config: P08_CONFIG, jev, goalsDir, sleep: async () => {}, textHelper: async () => ({ ok: false, error: "x" }) }),
    call,
    clicks,
  };
}

test("P10 : la cible change entre décision et dispatch -> AUCUN clic", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p10-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { runner, call, clicks } = guardChangeFixture(dir);
  const started = await runner.start(call, { goal: "ouvre le produit", tabId: 7, maxSteps: 2 });
  const final = await runner.wait(started.runId, 5000);
  assert.equal(clicks.length, 0, `aucun dispatch ne doit avoir lieu quand la cible a changé (reçu ${clicks.length})`);
  const notes = final.steps.map((s) => s.note).filter(Boolean);
  assert.ok(
    notes.some((n) => String(n).includes("target changed since the decision")),
    `le motif doit être tracé (notes: ${JSON.stringify(notes)})`
  );
});

test("P10 : cible inchangée -> le clic est bien dispatché (non-régression)", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p10b-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const answerChoice = (questions, id, choiceId, confidence = 0.9) => {
    const keys = Object.keys(questions[id].criteria);
    const others = keys.filter((k) => k !== choiceId);
    const probabilities = {};
    for (const key of keys) probabilities[key] = key === choiceId ? (others.length ? 0.9 : 1) : others.length ? 0.1 / others.length : 0;
    return { type: "choice", choice: choiceId, probabilities, confidence };
  };
  let step = 0;
  const jev = {
    disabled: false, model: "jev-test",
    async ask(_s, questions) {
      const script = [{ operation: "CLICK", click_target: "1" }, { operation: "DONE" }, { operation: "DONE" }];
      const pick = script[Math.min(step, 2)];
      step += 1;
      const answers = {};
      for (const [id, choiceId] of Object.entries(pick)) answers[id] = answerChoice(questions, id, choiceId);
      return { ok: true, answers, model: "jev-test", tookMs: 5, cached: false };
    },
  };
  const clicks = [];
  let n = 0;
  const call = async (name, args) => {
    if (name === "action_space") {
      n += 1;
      const action = {
        id: "a1", node: "a1", kind: "click", label: "Continuer",
        rect: { x: 1, y: 1, w: 30, h: 20 }, role: "link",
        href: "/stable", target_guard: "/stable\u0000\u0000",
      };
      return { ok: true, url: "https://example.com", title: "Page", text: "Article", marker: `m${n}`, actions: [action] };
    }
    if (name === "element_info") return { found: true, element: { wbId: "a1" } };
    if (name === "click_element") { clicks.push(args); return { ok: true }; }
    if (name === "evaluate") return { value: 1 };
    throw new Error(name);
  };
  const runner = new GoalRunner({ config: P08_CONFIG, jev, goalsDir: dir, sleep: async () => {}, textHelper: async () => ({ ok: false, error: "x" }) });
  const started = await runner.start(call, { goal: "ouvre le produit", tabId: 7, maxSteps: 1 });
  await runner.wait(started.runId, 5000);
  assert.equal(clicks.length, 1, "une cible stable doit être cliquée normalement");
});

test("P10 : une observation sans cible (extension ancienne) n'est pas refusée", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p10c-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // Aucune cible exposée : le guard ne doit pas devenir un refus systématique.
  const { runner, call, clicks } = guardChangeFixture(dir);
  const patched = async (name, args) => {
    const result = await call(name, args);
    if (name === "action_space") {
      for (const action of result.actions) {
        delete action.href; delete action.form_action; delete action.target; delete action.target_guard;
      }
    }
    return result;
  };
  const started = await runner.start(patched, { goal: "ouvre le produit", tabId: 7, maxSteps: 1 });
  await runner.wait(started.runId, 5000);
  assert.equal(clicks.length, 1, "sans information de cible, on n'invente pas un refus");
});

test("P10 : une observation pré-dispatch en échec pause en observation_failed (PAS after_action)", async (t) => {
  // Bug de nommage corrigé : rien n'a été dispatché, donc la raison ne doit pas
  // être `observation_failed_after_action` — depuis P06, cette raison refuse
  // toute reprise (effet inconnu), ce qui créait un deadlock.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p10d-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { runner, call, clicks } = guardChangeFixture(dir);
  let observations = 0;
  const failing = async (name, args) => {
    if (name === "action_space") {
      observations += 1;
      if (observations > 1) return { ok: false, error: "tab gone" }; // échec pré-dispatch
    }
    return call(name, args);
  };
  const started = await runner.start(failing, { goal: "ouvre le produit", tabId: 7, maxSteps: 2 });
  const paused = await runner.wait(started.runId, 5000);
  assert.equal(clicks.length, 0, "rien ne doit être dispatché");
  assert.equal(paused.status, "paused");
  assert.equal(paused.lastPause?.reason, "observation_failed", `raison reçue: ${paused.lastPause?.reason}`);
  // Et la reprise doit être POSSIBLE (pas de deadlock) : elle exige un hint (P09).
  const resumed = await runner.resume(call, { runId: started.runId, hint: "l'onglet est revenu, réessaie" });
  assert.match(resumed.goal, /\[Hint\]/);
});

test("P11 : no_page_change est paused (reprenable), pas blocked (terminal)", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p11-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const answerChoice = (questions, id, choiceId, confidence = 0.9) => {
    const keys = Object.keys(questions[id].criteria);
    const others = keys.filter((k) => k !== choiceId);
    const probabilities = {};
    for (const key of keys) probabilities[key] = key === choiceId ? (others.length ? 0.9 : 1) : others.length ? 0.1 / others.length : 0;
    return { type: "choice", choice: choiceId, probabilities, confidence };
  };
  let step = 0;
  const jev = {
    disabled: false, model: "jev-test",
    async ask(_s, questions) {
      const script = [
        { operation: "CLICK", click_target: "1" },
        { operation: "CLICK", click_target: "1" },
        { operation: "CLICK", click_target: "1" },
        { operation: "DONE" },
      ];
      const pick = script[Math.min(step, script.length - 1)];
      step += 1;
      const answers = {};
      for (const [id, choiceId] of Object.entries(pick)) answers[id] = answerChoice(questions, id, choiceId);
      return { ok: true, answers, model: "jev-test", tookMs: 5, cached: false };
    },
  };
  const action = { id: "a1", node: "a1", kind: "click", label: "Continuer", rect: { x: 1, y: 1, w: 30, h: 20 }, role: "link", href: "/stable", target_guard: "/stable\u0000\u0000" };
  // Le marker NE CHANGE JAMAIS : les 3 clics ne modifient rien.
  const call = async (name) => {
    if (name === "action_space") return { ok: true, url: "https://example.com", title: "Page", text: "Article", marker: "m-fixed", actions: [action] };
    if (name === "element_info") return { found: true, element: { wbId: "a1" } };
    if (name === "click_element") return { ok: true };
    if (name === "evaluate") return { value: 1 };
    throw new Error(name);
  };
  const runner = new GoalRunner({ config: P08_CONFIG, jev, goalsDir: dir, sleep: async () => {}, textHelper: async () => ({ ok: false, error: "x" }) });
  const started = await runner.start(call, { goal: "clique", tabId: 7 });
  const final = await runner.wait(started.runId, 5000);
  assert.equal(final.status, "paused", `statut reçu: ${final.status}`);
  assert.equal(final.lastPause?.reason, "no_page_change");
  // Le conseil fourni est APPLICABLE : la reprise fonctionne.
  const resumed = await runner.resume(call, { runId: started.runId, hint: "la cible a changé" });
  assert.match(resumed.goal, /\[Hint\]/);
});

test("P11 : un resume de no_page_change sans hint reste refusé (P09 tient)", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p11b-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const answerChoice = (questions, id, choiceId, confidence = 0.9) => {
    const keys = Object.keys(questions[id].criteria);
    const others = keys.filter((k) => k !== choiceId);
    const probabilities = {};
    for (const key of keys) probabilities[key] = key === choiceId ? (others.length ? 0.9 : 1) : others.length ? 0.1 / others.length : 0;
    return { type: "choice", choice: choiceId, probabilities, confidence };
  };
  let step = 0;
  const jev = {
    disabled: false, model: "jev-test",
    async ask(_s, questions) {
      const script = [
        { operation: "CLICK", click_target: "1" },
        { operation: "CLICK", click_target: "1" },
        { operation: "CLICK", click_target: "1" },
        { operation: "DONE" },
      ];
      const pick = script[Math.min(step, script.length - 1)];
      step += 1;
      const answers = {};
      for (const [id, choiceId] of Object.entries(pick)) answers[id] = answerChoice(questions, id, choiceId);
      return { ok: true, answers, model: "jev-test", tookMs: 5, cached: false };
    },
  };
  const action = { id: "a1", node: "a1", kind: "click", label: "Continuer", rect: { x: 1, y: 1, w: 30, h: 20 }, role: "link", href: "/stable", target_guard: "/stable\u0000\u0000" };
  const call = async (name) => {
    if (name === "action_space") return { ok: true, url: "https://example.com", title: "Page", text: "Article", marker: "m-fixed", actions: [action] };
    if (name === "element_info") return { found: true, element: { wbId: "a1" } };
    if (name === "click_element") return { ok: true };
    if (name === "evaluate") return { value: 1 };
    throw new Error(name);
  };
  const runner = new GoalRunner({ config: P08_CONFIG, jev, goalsDir: dir, sleep: async () => {}, textHelper: async () => ({ ok: false, error: "x" }) });
  const started = await runner.start(call, { goal: "clique", tabId: 7 });
  await runner.wait(started.runId, 5000);
  await assert.rejects(() => runner.resume(call, { runId: started.runId }), /resume_requires_new_context/);
});

// ---------------------------------------------------------------------------
// B2.8 (O7) — plafond d'appels au helper TEXTE.
// `textCalls` était compté mais jamais borné : chaque TYPE_TEXT est un appel
// payant, et un but ambigu pouvait en consommer un nombre non borné.
// ---------------------------------------------------------------------------

test("O7 : le plafond d'appels texte arrête le run AVANT l'appel payant", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "o7-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const answerChoice = (questions, id, choiceId, confidence = 0.9) => {
    const keys = Object.keys(questions[id].criteria);
    const others = keys.filter((k) => k !== choiceId);
    const probabilities = {};
    for (const key of keys) probabilities[key] = key === choiceId ? (others.length ? 0.9 : 1) : others.length ? 0.1 / others.length : 0;
    return { type: "choice", choice: choiceId, probabilities, confidence };
  };
  const jev = {
    disabled: false, model: "jev-test",
    async ask(_s, questions) {
      // Toujours TYPE_TEXT : le run veut remplir un champ à chaque tour.
      const answers = {};
      for (const id of Object.keys(questions)) {
        const keys = Object.keys(questions[id].criteria);
        const pick = keys.includes("TYPE_TEXT") ? "TYPE_TEXT" : keys.includes("type_text_target") ? "1" : keys[0];
        answers[id] = answerChoice(questions, id, pick);
      }
      return { ok: true, answers, model: "jev-test", tookMs: 5, cached: false };
    },
  };
  const action = { id: "a1", node: "a1", kind: "fill", label: "Champ", rect: { x: 1, y: 1, w: 30, h: 20 }, role: "textbox", value: "" };
  let marker = 0;
  const call = async (name) => {
    if (name === "action_space") {
      marker += 1;
      return { ok: true, url: "https://example.com", title: "Page", text: "Article", marker: `m${marker}`, actions: [action] };
    }
    if (name === "element_info") return { found: true, element: { wbId: "a1" } };
    if (name === "evaluate") return { value: { found: true, value: "x" } };
    if (name === "click_element" || name === "type_element") return { ok: true };
    throw new Error(name);
  };
  let helperCalls = 0;
  const runner = new GoalRunner({
    config: P08_CONFIG,
    jev,
    goalsDir: dir,
    sleep: async () => {},
    textHelper: async () => { helperCalls += 1; return { ok: true, text: "valeur", meta: { model: "fake", tookMs: 1 } }; },
    maxTextCalls: 2,
  });
  const started = await runner.start(call, { goal: "remplis les champs", tabId: 7 });
  const final = await runner.wait(started.runId, 5000);
  assert.equal(helperCalls, 2, `le helper ne doit pas être appelé au-delà du plafond (reçu ${helperCalls})`);
  assert.equal(final.status, "paused");
  assert.equal(final.lastPause?.reason, "text_call_budget");
  assert.equal(final.maxTextCalls, 2, "le plafond effectif est exposé dans l'état");
});

test("O7 : le plafond est borné par un maximum dur même si l'appelant demande plus", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "o7b-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const jev = { disabled: false, async ask() { return { ok: true, answers: {}, tookMs: 0, cached: false }; } };
  const action = { id: "a1", node: "a1", kind: "fill", label: "Champ", rect: { x: 1, y: 1, w: 30, h: 20 }, role: "textbox", value: "" };
  const call = async (name) => {
    if (name === "action_space") return { ok: true, url: "https://example.com", title: "Page", text: "Article", marker: "m1", actions: [action] };
    if (name === "element_info") return { found: true, element: { wbId: "a1" } };
    if (name === "evaluate") return { value: { found: true, value: "x" } };
    return { ok: true };
  };
  const runner = new GoalRunner({ config: P08_CONFIG, jev, goalsDir: dir, sleep: async () => {}, textHelper: async () => ({ ok: true, text: "v", meta: { model: "f", tookMs: 1 } }), maxTextCalls: 999 });
  const started = await runner.start(call, { goal: "remplis", tabId: 7 });
  assert.equal(started.maxTextCalls, 50, `plafond dur attendu (reçu ${started.maxTextCalls})`);
});

// ---------------------------------------------------------------------------
// G3 — retrait panier vs suppression destructive.
//
// `supprimer` et `delete` figuraient dans le refus dur lexical : le bouton d'un
// retrait d'article de panier s'appelant précisément « Supprimer » / « Delete »,
// l'opération légitime était impossible. Le refus dur ne doit pas confondre
// « retirer une ligne de panier » et « supprimer un compte ».
// ---------------------------------------------------------------------------

test("G3 : un libellé de retrait panier n'est plus bloqué par le refus dur", async () => {
  let asked = 0;
  const result = await authorizeGoalAction(
    {
      ask: async () => {
        asked += 1;
        // Jev classe le retrait comme mutation de panier.
        return {
          ok: true,
          answers: {
            effect: {
              choice: "cart",
              confidence: 0.9,
              probabilities: { browse: 0.02, edit: 0.02, cart: 0.92, commit: 0.01, sensitive: 0.01, unknown: 0.02 },
            },
          },
        };
      },
    },
    {
      goal: "retire les câbles du panier",
      url: "https://shop.example/cart",
      action: { id: "a1", kind: "click", label: "Supprimer" },
      safety: { version: 1, allowedOrigins: ["https://shop.example"], allowCart: true },
    }
  );
  assert.notEqual(result.reason, "requires_explicit_approval", `« Supprimer » sur une ligne de panier ne doit plus être un refus dur (reçu ${JSON.stringify(result)})`);
  assert.equal(result.ok, true, `le retrait de panier doit être autorisé (reçu ${JSON.stringify(result)})`);
  assert.equal(asked, 1, "le modèle doit avoir été consulté, pas court-circuité");
});

test("G3 : « Delete » seul avec allowCart est une mutation de panier, pas un refus dur", async () => {
  const result = await authorizeGoalAction(
    {
      ask: async () => ({
        ok: true,
        answers: {
          effect: {
            choice: "cart",
            confidence: 0.88,
            probabilities: { browse: 0.02, edit: 0.03, cart: 0.9, commit: 0.02, sensitive: 0.01, unknown: 0.02 },
          },
        },
      }),
    },
    {
      goal: "retire cet article du panier",
      url: "https://shop.example/cart",
      action: { id: "a1", kind: "click", label: "Delete" },
      safety: { version: 1, allowedOrigins: ["https://shop.example"], allowCart: true },
    }
  );
  assert.notEqual(result.reason, "requires_explicit_approval");
});

test("G3 : sans autorité panier, un retrait est refusé", async () => {
  const result = await authorizeGoalAction(
    {
      ask: async () => ({
        ok: true,
        answers: {
          effect: {
            choice: "cart",
            confidence: 0.9,
            probabilities: { browse: 0.02, edit: 0.02, cart: 0.92, commit: 0.01, sensitive: 0.01, unknown: 0.02 },
          },
        },
      }),
    },
    {
      goal: "retire les câbles du panier",
      url: "https://shop.example/cart",
      action: { id: "a1", kind: "click", label: "Supprimer" },
      safety: { version: 1, allowedOrigins: ["https://shop.example"], allowCart: false },
    }
  );
  assert.equal(result.ok, false, "sans allowCart, un retrait ne doit pas passer");
});

test("G3 : « supprimer le compte » et « Delete account » restent REFUSÉS", async () => {
  for (const label of ["Supprimer le compte", "Delete account", "Supprimer mon profil", "Delete my account data"]) {
    const result = await authorizeGoalAction(
      {
        ask: async () => ({
          ok: true,
          answers: {
            effect: {
              choice: "sensitive",
              confidence: 0.95,
              probabilities: { browse: 0.01, edit: 0.01, cart: 0.01, commit: 0.01, sensitive: 0.95, unknown: 0.01 },
            },
          },
        }),
      },
      {
        goal: "nettoyer",
        url: "https://shop.example/account",
        action: { id: "a1", kind: "click", label },
        safety: { version: 1, allowedOrigins: ["https://shop.example"], allowCart: true },
      }
    );
    assert.equal(result.ok, false, `${label} doit rester refusé`);
    assert.equal(result.reason, "requires_explicit_approval", `${label} : refus dur attendu (reçu ${result.reason})`);
  }
});

test("G3 : les refus durs inchangés le restent (paiement, identifiants, consentement)", async () => {
  for (const label of ["Passer la commande", "Buy now", "Payer", "Se connecter", "Accept all cookies", "Consent"]) {
    const result = await authorizeGoalAction(
      { ask: async () => ({ ok: true, answers: {} }) },
      {
        goal: "x",
        url: "https://shop.example/p/x",
        action: { id: "a1", kind: "click", label },
        safety: { version: 1, allowedOrigins: ["https://shop.example"], allowCart: true },
      }
    );
    assert.equal(result.ok, false, `${label} doit rester refusé`);
    assert.equal(result.reason, "requires_explicit_approval", `${label} : refus dur attendu`);
  }
});

// ---------------------------------------------------------------------------
// Live 18:44 — YouTube PNL : `text_helper_failed: This operation was aborted`
// au PREMIER appel sur combobox[name=search_query] → but en pause, rien tapé.
// Correctif : un abort réseau (pas un dépassement de délai côté notre timer)
// est tenté UNE seconde fois avant d'échouer.
// ---------------------------------------------------------------------------

test("abort réseau du helper : un second essai réussit (live YouTube 18:44)", async () => {
  let calls = 0;
  const helper = createTextHelper({ apiKey: "k", timeoutMs: 5_000 }, async () => {
    calls += 1;
    if (calls === 1) {
      const error = new Error("This operation was aborted");
      error.name = "AbortError";
      throw error;
    }
    return { ok: true, status: 200, json: async () => OK_BODY };
  });
  const result = await helper(FIELD_CONTEXT);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.text, "ok");
  assert.equal(calls, 2);
});

test("abort réseau du helper : deux échecs → échec propre, pas de boucle", async () => {
  let calls = 0;
  const helper = createTextHelper({ apiKey: "k", timeoutMs: 5_000 }, async () => {
    calls += 1;
    const error = new Error("This operation was aborted");
    error.name = "AbortError";
    throw error;
  });
  const result = await helper(FIELD_CONTEXT);
  assert.equal(result.ok, false);
  assert.equal(calls, 2, "exactement un retry, jamais plus");
});

test("timeout de REQUÊTE (notre timer) : PAS de retry, 1 seul appel fetch", async () => {
  let calls = 0;
  const helper = createTextHelper({ apiKey: "k", timeoutMs: 60 }, async (_url, opts) => {
    calls += 1;
    // Ne répond jamais : seul le signal d'abort du helper peut mettre fin à l'appel.
    return new Promise((_resolve, reject) => {
      opts.signal.addEventListener("abort", () => {
        const error = new Error("This operation was aborted");
        error.name = "AbortError";
        reject(error);
      });
    });
  });
  const started = Date.now();
  const result = await helper(FIELD_CONTEXT);
  const elapsed = Date.now() - started;
  assert.equal(result.ok, false);
  assert.equal(calls, 1, "notre propre timeout ne doit JAMAIS être retenté");
  assert.ok(elapsed < 500, `budget non doublé (attendu ~60 ms, obtenu ${elapsed} ms)`);
});
