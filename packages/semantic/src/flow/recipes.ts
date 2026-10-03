// Built-in recipes. User recipes load from WEBBRIDGE_FLOW_DIR (default
// <cwd>/.webbridge-data/flows). The first real-world recipe (kdp-ebook) lands
// in PR 5/7 — see docs/semantic-feature-implementation-plan.md §6.

import type { FlowRecipe } from "./dsl.js";

export const BUILT_IN_RECIPES: FlowRecipe[] = [
  {
    id: "demo-example",
    title: "Demo: navigate → verify → find_click → gate (example.com → iana.org)",
    site: "example.com",
    steps: [
      { do: "navigate", url: "https://example.com", desc: "open example.com" },
      {
        do: "verify",
        desc: "example.com loaded",
        expect: {
          loaded: {
            type: "noul",
            instructions: "The page is the Example Domain page with heading 'Example Domain' and a link to more information",
          },
        },
      },
      { do: "screenshot", label: "loaded" },
      { do: "find_click", description: "the More information link", desc: "follow to iana.org" },
      {
        do: "wait_text",
        includes: "IANA",
        timeoutMs: 15000,
        desc: "iana.org appears",
      },
      {
        do: "verify",
        desc: "iana.org loaded",
        expect: {
          iana: {
            type: "noul",
            instructions: "The page is the IANA (Internet Assigned Numbers Authority) website",
          },
        },
      },
      { do: "screenshot", label: "iana" },
      { do: "gate", id: "demo-done", label: "Demo complete", requireApproval: true },
    ],
  },
];
