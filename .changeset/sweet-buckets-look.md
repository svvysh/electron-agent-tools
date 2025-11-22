---
"electron-agent-tools": minor
---

- Add world-aware helpers (renderer/isolated/preload eval, lifecycle hooks, waitForBridge) plus deterministic `injectGlobals`.
- Introduce IPC tracing and harvesting, console filtering, DOM dump, and snapshot-globals utilities for richer debugging.
- Fixture app now exposes bridge readiness and IPC echo for the new helpers and docs cover the expanded API surface.
