---
"electron-agent-tools": patch
---

Handle closed stdout/stderr cleanly by swallowing EPIPE and using safe writes in CLI entrypoints so consumers no longer need to add their own hack.
