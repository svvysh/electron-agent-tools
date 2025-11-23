---
"electron-agent-tools": patch
---

Harden stdio EPIPE handling by making the guard idempotent and swallowing uncaughtException EPIPEs so downstream apps can drop their manual pipe hacks.
