# electron-agent-tools

## 0.2.1

### Patch Changes

- 2a81185: - stream all runtime signals into per-run `run.log` and remove harvest/flush APIs
  - drop console/ipc/network harvest/DOM snapshot CLI commands; keep screenshot/dom-dump artifacts in run dir
  - expose runLogPath from launch, reuse last-run artifacts, and update docs/tests to match the new logging model

## 0.2.0

### Minor Changes

- 5c2afbc: - Add world-aware helpers (renderer/isolated/preload eval, lifecycle hooks, waitForBridge) plus deterministic `injectGlobals`.
  - Introduce IPC tracing and harvesting, console filtering, DOM dump, and snapshot-globals utilities for richer debugging.
  - Fixture app now exposes bridge readiness and IPC echo for the new helpers and docs cover the expanded API surface.

## 0.1.7

### Patch Changes

- d469ce1: Fix missing undefined property.

## 0.1.6

### Patch Changes

- 0128799: Fix types with exact undefined properties.

## 0.1.5

### Patch Changes

- e0912bf: Fix imports.

## 0.1.4

### Patch Changes

- 322b930: Include entire README in llms.txt.

## 0.1.3

### Patch Changes

- 6d30c69: Add llms.txt to release

## 0.1.2

### Patch Changes

- 78a8204: Better Readme.

## 0.1.1

### Patch Changes

- 8a32dc7: Initial release.
