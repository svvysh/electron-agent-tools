---
"electron-agent-tools": patch
---

Always create a run logger in `connectAndPick`, defaulting to `.e2e-artifacts/last-run/run.log`, so renderer/preload/main/network/ipc logs are captured even when callers omit `runLogPath`.
