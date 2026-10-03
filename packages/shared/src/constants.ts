export const NATIVE_HOST_NAME = "com.webbridge.host";

export const DEFAULT_WS_PORT = 10088;
export const DEFAULT_WS_HOST = "127.0.0.1";
export const DEFAULT_HTTP_PORT = 10087;

export const HEARTBEAT_INTERVAL_MS = 30_000;
export const HEARTBEAT_TIMEOUT_MS = 10_000;
export const TOOL_CALL_TIMEOUT_MS = 60_000;
export const RECONNECT_DELAY_MS = 3_000;
export const MAX_RECONNECT_ATTEMPTS = 10;

// --- Tab lifecycle guardrails ----------------------------------------------
// Prevents runaway tab creation when agents retry on SPA hangs or aborted calls.
// Hard ceiling on simultaneously tracked agent-created tabs. When acquireTab()
// would exceed it, the oldest non-primary agent tab is closed first.
export const MAX_AGENT_TABS = 8;
// Internal navigation load-wait budget. Must stay well below TOOL_CALL_TIMEOUT_MS
// (60s) and below typical agent-shell timeouts (~30s) so a result always returns
// before the caller aborts and retries (which would create another tab).
export const NAVIGATE_LOAD_TIMEOUT_MS = 6_000;
export const NAVIGATE_NETWORKIDLE_TIMEOUT_MS = 10_000;
// Default light settle when waitUntil is omitted (fast return, SPA-friendly).
export const NAVIGATE_SETTLE_MS = 4_000;
// Daemon-side in-flight + recently-completed dedup window for navigate/new_tab.
export const TOOL_DEDUP_WINDOW_MS = 3_000;
// Optional idle auto-finalize for agent tabs. 0 = disabled (no surprise closes).
// Set > 0 (ms) to auto-close all agent tabs after this much inactivity.
export const SESSION_IDLE_TTL_MS = 0;

export const CDP_PROTOCOL_VERSION = "1.3";

// --- Semantic side-feature (Jev / TypeSafe) — opt-in -----------------------
// All logic lives in packages/semantic. These defaults only avoid a
// daemon→semantic dependency for configuration fallbacks.
export const DEFAULT_JEV_MODEL = "jev-latest";
export const DEFAULT_JEV_BASE_URL = "https://api.typesafe.ai";
export const DEFAULT_JEV_TIMEOUT_MS = 3_000;
export const DEFAULT_JEV_MIN_CONFIDENCE = 0.5;
export const DEFAULT_JEV_MAX_CANDIDATES = 60;
// Flow runner hard ceiling (safety, PR 4+).
export const MAX_FLOW_STEPS = 200;

export const CURSOR_ANIMATION_MS = 250;

export const EXTENSION_VERSION = "0.1.0";
