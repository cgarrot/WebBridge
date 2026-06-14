# Generic Feature Plan

This plan captures reusable WebBridge capabilities without promoting any site-specific workflow into core behavior.

## Principles

- Keep core tools site-neutral: tools should operate on tabs, pages, DOM, CDP, media primitives, and explicit caller-provided scripts/selectors.
- Prefer explicit opt-in instrumentation over implicit content scripts.
- Keep launchers neutral: local wrappers may pass configuration, but WebBridge core should not hardcode product endpoints or project names.
- Treat permissions that can expose sensitive user data as gated future work, documented and reviewed before shipping.

## Reusable feature candidates

### 1. Generic live text extraction

Provide reusable live-text utilities that can poll caller-selected DOM regions, accessibility live regions, or caller-provided selectors with bounded output and deduplication. The core API should not contain selectors for a particular website. Site-specific recipes can live in external examples or agent-side prompts.

### 2. Reusable offscreen infrastructure

If future features need extension offscreen documents, introduce a small generic offscreen lifecycle layer: create/status/close, bounded message protocol, cleanup on idle, and structured errors. Keep feature-specific recording, transcription, or forwarding outside this base layer.

### 3. Future tab audio capture with privacy gates

Tab audio capture can become a generic capability only with explicit privacy and permission gates: clear user intent, minimal retention, no persisted stream IDs, visible lifecycle state, bounded buffers, and no default third-party forwarding. Required permissions such as `tabCapture` or `offscreen` should be added only with a dedicated review and release note.

### 4. Explicit preload and instrumentation

Keep `preload_script` and `preload_navigate` generic: callers provide the script source, target tab/navigation, and execution mode. WebBridge should enforce size limits, browser-internal URL handling, and clear guidance, but should not embed site-specific instrumentation.

### 5. Launcher neutrality

Daemon/extension launchers should expose generic configuration knobs and environment variables. Avoid hardcoded endpoints, vendors, or customer workflows in core scripts; project-specific integrations should live outside the generic WebBridge package.

## What not to put in core

Do not add website selectors, page-specific content scripts, vendor payload formats, or project-specific callback endpoints as built-in generic behavior. Those belong in external examples, local experiments, or separate opt-in integrations built on the generic tools above.
