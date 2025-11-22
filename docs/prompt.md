You are to implement a TypeScript library + CLI named **electron-agent-tools** exactly per the SPEC below.
**MANDATORY**: Use **Playwright** (prefer `chromium.connectOverCDP`) for all browser automation. DO NOT use MCP or bespoke CDP plumbing.

Refer to docs/specs.md for the full specification.

=== SPEC SUMMARY (authoritative) ===
- Node >=18, ESM package. Dependencies: Playwright.
- Provide:
 1) CLI: `browser-tools <subcmd>` (JSON-in/JSON-out). Add subcommands `press`, `hover`, `scroll-into-view`, `upload`, `wait-for-window`, `switch-window` plus existing actions. Artifacts accept `artifactDir`/`artifactPrefix` overrides. Optional CLI: `launch-electron start|quit` to spawn and drain Electron with JSON output.
  2) Library API: `connectAndPick(opts)` returns a Driver wrapping **Playwright Page** with methods: click, type, press, hover, scrollIntoView, upload, waitText, screenshot, dumpOuterHTML, listSelectors, waitForWindow, switchWindow, flushConsole, flushNetwork, close **plus world-aware helpers (evalInPreload/Isolated/Renderer), lifecycle hooks, deterministic helper injection, IPC tracing, snapshotGlobals, waitForTextAcrossReloads, dumpDOM, getRendererInspectorUrl**.
  3) Library helper: `launchElectron(opts)` to spawn the Electron app, pick CDP port, capture stdout/stderr artifacts, return `{ wsUrl, pid, quit }`.
  3) Selector strategy: prefer Playwright locators (data-testid -> role/name -> text -> CSS). Visibility handling left to Playwright.
 4) Launch: either consumer-spawned or via `launchElectron`. Suggested env: E2E=1, NODE_ENV=test, E2E_CDP_PORT, ELECTRON_ENABLE_LOGGING=1; discover `webSocketDebuggerUrl` from http://127.0.0.1:<port>/json/version.
  5) Each CLI subcommand consumes one JSON arg and prints EXACTLY one JSON result (success or error).
  6) Driver connects with `chromium.connectOverCDP(wsUrl)` and uses Playwright APIs for all actions and harvesting.
  7) Artifacts directory configurable via `artifactDir` / `artifactPrefix` (default `.e2e-artifacts/<timestamp>/` + `last-run` symlink). Includes screenshots, snapshots, harvests, and launch logs.
  9) Include examples in /examples: smoke.js, smoke.sh, dom-dump.js (as described in the SPEC).
10) Include a working **fixture Electron app** under /fixtures that renders `click button` + button with data-testid
     `click-button` which, when clicked, changes the H1 to `Select a folder`. It can be launched via
     `pnpm exec electron fixtures/main.js` (no separate package.json required).
11) Provide tests under /tests that run the examples against the fixture (Node built-in test runner). 
     The tests must: install fixture deps, run smoke.js (or CLI flow), then assert `.e2e-artifacts/smoke.png` exists.
 12) CI workflow `.github/workflows/ci.yml`: pnpm install, Biome lint/format check, TypeScript build, and run tests under Xvfb on Linux.
13) Release workflow `.github/workflows/release.yml`: uses Changesets on pushes to `main` to open a release PR (or publish)
     via `changesets/action@v1`, `pnpm version-packages`, and `pnpm release` (requires `NPM_TOKEN`).

=== CHANGESET FLOW ===
- `.changeset/config.json` is initialized with `baseBranch: "main"` and `access: "public"`.
- Add release notes with `pnpm changeset add` (pick bump + summary).
- For local release prep: `pnpm version-packages` (applies changesets, bumps versions, updates lockfile).
- Publishing (local or CI): `pnpm release` (runs build + `changeset publish` with provenance).
 14) Provide `package.json`, `tsconfig.json`, `biome.json`, and README.md (short setup + examples). 
      `package.json` must expose bins and the library API via `exports`, and include scripts:
      - build, lint, format, check, test (node --test).
 15) Error codes: E_SPAWN, E_CDP_TIMEOUT, E_NO_PAGE, E_SELECTOR, E_WAIT_TIMEOUT, E_FS, E_IPC_GUARD, E_INTERNAL. 
      Surface them in the CLI JSON error output.

=== IMPLEMENTATION GUIDELINES ===
- Keep functions small; add concise comments and JSDoc/TSDoc on public APIs.
- All CLIs must read a single JSON arg (from argv[1]) and print a single JSON line to stdout, nothing else.
- Use Node's built-in fetch for /json/version polling.
- Connect with `chromium.connectOverCDP` and pick the main renderer page; use Playwright `Page` methods for clicks, typing, waits, screenshots, console/network listeners, etc.
