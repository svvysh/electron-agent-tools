# SPEC — `electron-agent-tools` (Playwright, CDP connect)

> A tiny TypeScript library + CLI that lets humans or LLMs **launch and drive an Electron Forge app** using **Playwright** (via `chromium.connectOverCDP`). No MCP; no bespoke CDP wiring.

## 0) Goals & non‑goals

* **Goals**
  * Provide a **small registry of tools** (library APIs + CLI entrypoints) to launch, inspect, and drive an Electron app: click buttons, type, read DOM/HTML, capture screenshots, harvest console/network, optional test‑only IPC.
  * **Deterministic JSON I/O** for each CLI command; suitable for LLM orchestration.
  * Use **Playwright for everything** (locator engine, waits, screenshots, console/network listeners).
* **Headless/background OK**; GUI visibility not required (Electron launched with `--headless --disable-gpu` when `E2E_HEADLESS=1` or `headless: true`; fallback to Xvfb in CI on Linux if needed).
  * **Safety & cleanup** on failure/SIGINT; artifacts and logs collected.

* **Non‑goals**
  * Not a general test framework.
  * No MCP servers; no distributed runners.

## 1) Runtime & packaging

* **Node**: ≥ 18 (uses built‑in `fetch`), CI uses Node 20+.
* **Package type**: ESM.
* **OS**: macOS, Windows, Linux. CI targets Linux with **Xvfb**.
* **Dependencies**:
  * runtime: `"playwright"` (use chromium).
* **Dev dependencies**: `"typescript"`, `"@types/node"`, `"@biomejs/biome"`.

## 2) Launch & connection model

* Two paths:
  * **Consumer-managed**: launch the Electron app (e.g., `pnpm exec electron ...`) with env `E2E=1`, `NODE_ENV=test`, `E2E_CDP_PORT=<port>`, `ELECTRON_ENABLE_LOGGING=1`, then call `getWsUrl` to discover `wsUrl`.
* **Library helper**: `launchElectron(opts)` spawns the Electron command, picks/assigns a CDP port, polls for `wsUrl`, records stdout/stderr into artifacts, and returns `{ wsUrl, pid, electronPid?, quit }`; `quit()` gracefully ends the launched app. A CLI twin `launch-electron start|quit` is allowed.
* App must enable CDP in **main**:

  ```ts
  import { app } from 'electron';
  if (process.env.E2E_CDP_PORT) {
    app.commandLine.appendSwitch('remote-debugging-port', process.env.E2E_CDP_PORT);
  }
  ```

* Library helper `getWsUrl({ port, timeoutMs })` polls `http://127.0.0.1:<port>/json/version` until it sees `webSocketDebuggerUrl`, then returns it.
* Driver connects to the **browser** WS endpoint via `chromium.connectOverCDP(wsUrl)`, enumerates **targets** (type `page`), and selects the main renderer:
  * Prefer URLs starting `app://`, `file://`, or `http://localhost:`; else match `pick.titleContains`/`pick.urlIncludes`.

## 3) CLI command registry (JSON in → JSON out)

All commands print **exactly one** JSON object to stdout:

Success:

```json
{ "ok": true, "data": { ... } }
```

Failure:

```json
{ "ok": false, "error": { "message": "...", "code": "E_CODE", "details": { ... } } }
```

Invalid JSON input is rejected before dispatch with exit code 1:

```json
{ "ok": false, "error": { "code": "E_BAD_JSON", "message": "Invalid JSON input", "details": { "rawArg": "...", "parseError": "..." } } }
```

General options (per command): `timeoutMs` (default 10000 unless noted), `retries` (default 0), `wsUrl` when a CDP connection is needed. Artifact-producing commands accept `artifactDir` (default `.e2e-artifacts`) and `artifactPrefix` (default `<unix-ts>` directory name) to control where outputs land.

### 3.1 `browser-tools <subcommand>`

Single binary dispatching subcommands; each takes a single JSON arg.

Subcommands and inputs (implemented via Playwright `Page`):

* **`list-windows`** → `{ "wsUrl": "…" }`  
  **Output**: `{ "pages":[ { "targetId","url","title" } ] }`

* **`dom-snapshot`** → `{ "wsUrl":"…", "truncateAt": 250000 }`  
  **Output**: `{ "url","title","outerHTML" }`

* **`list-selectors`** → `{ "wsUrl":"…", "max":200 }`  
  **Output**:

  ```json
  {
    "testIds": ["click-button", "..."],
    "roles": [ { "role":"button","name":"click button","selector":"button" } ],
    "texts": [ { "text":"click button","selector":"button" } ]
  }
  ```

* **`wait-text`** → `{ "wsUrl":"…", "text":"click button", "timeoutMs":20000 }`  
  **Output**: `{ "visible": true }` (Use `page.getByText(text).waitFor({ state: 'visible' })`.)

* **`click`** → selector schema (below)  
  **Output**: `{ "clicked": true }`

* **`type`** → selector + `{ "value":"foo", "clearFirst":true }`  
  **Output**: `{ "typed": true }`

* **`press`** → `{ "wsUrl":"…", "key":"Enter", ...Selector? }`  
  **Output**: `{ "pressed": "Enter" }` (Presses globally or on the selector.)

* **`hover`** → selector schema  
  **Output**: `{ "hovered": true }`

* **`scroll-into-view`** → selector schema  
  **Output**: `{ "scrolled": true }`

* **`upload`** → selector + `{ "filePath":"/abs/path" }`  
  **Output**: `{ "uploaded": "/abs/path" }`

* **`get-dom`** → selector + `{ "as":"innerHTML"|"textContent" }`  
  **Output**: `{ "value": "…" }`

* **`screenshot`** → `{ "wsUrl":"…", "path":”.e2e-artifacts/page.png", "fullPage": true }`  
  **Output**: `{ "path":"…" }`

* **`console-harvest`** → `{ "wsUrl":"…" }`  
  **Output**: `{ "events":[ { "type","text","ts" } ] }`

* **`network-harvest`** → `{ "wsUrl":"…" }`  
  **Output**: `{ "failed":[urls], "errorResponses":[ { "url","status" } ] }`

* **`wait-for-window`** → `{ "wsUrl":"…", "pick": { "titleContains"?, "urlIncludes"? }, "timeoutMs"? }`  
  **Output**: `{ "url","title" }` (returns once a matching window exists or appears.)

* **`switch-window`** → `{ "wsUrl":"…", "pick": { ... } }`  
  **Output**: `{ "url","title" }` (switches the active page for subsequent actions in that command.)

### 3.2 `launch-electron` (CLI helper)

* **`start|launch`** → `{ "command":"pnpm", "args":["exec","electron","fixtures/main.js"], "headless"?:true, "cdpPort"?, "artifactDir"?, "artifactPrefix"? }`  
  **Output**: `{ "wsUrl", "pid", "electronPid", "cdpPort", "artifactDir", "launchFile", "quitHint": { "pid","launchFile" } }` (`electronPid` points to the real Electron binary; use it for quits.)

### 3.4 CI shortcut

* `pnpm test:ci` → Sets `CI=1 E2E_HEADLESS=1` and runs the Node test suite (`pnpm test`). Suitable for GitHub Actions; no visible window.
* **`quit`** → `{ "pid":1234 }` or `{ "launchFile":".../launch.json" }`  
  **Output**: `{ "quit": true, "pid": 1234 }`


### 3.3 Selector schema (used by `click`, `type`, `get-dom`)

```ts
{
  "testid"?: string,
  "role"?: { "role": string, "name"?: string },
  "text"?: string,
  "css"?: string,
  "nth"?: number,
  "timeoutMs"?: number
}
```

**Resolution order**: `data-testid` → role/name → text substring → CSS. Implement via Playwright locators:

* `testid`: `page.getByTestId(sel.testid)`
* `role`: `page.getByRole(sel.role.role, { name: sel.role.name })`
* `text`: `page.getByText(sel.text, { exact: false })`
* `css`: `page.locator(sel.css)`

Use `locator.nth(nth ?? 0)` and rely on Playwright’s visibility/auto‑wait semantics.

## 4) Library API (TypeScript)

```ts
// src/lib/types.ts
export type ConnectOptions = { wsUrl: string; pick?: { titleContains?: string; urlIncludes?: string } };

export type ArtifactOptions = { artifactDir?: string; artifactPrefix?: string };

export type Selector = {
  testid?: string;
  role?: { role: string; name?: string };
  text?: string;
  css?: string;
  nth?: number;
  timeoutMs?: number;
};

export type ConsoleEvent = { type: string; text: string; ts: number };
export type NetworkHarvest = { failed: string[]; errorResponses: { url: string; status: number }[] };

export type LaunchOptions = {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  cdpPort?: number;
  timeoutMs?: number;
} & ArtifactOptions;

export type LaunchResult = {
  wsUrl: string;
  cdpPort: number;
  pid: number;
  artifactDir: string;
  launchFile?: string;
  quit: () => Promise<void>;
};

export interface Driver {
  click(sel: Selector): Promise<void>;
  type(sel: Selector & { value: string; clearFirst?: boolean }): Promise<void>;
  press(key: string, sel?: Selector): Promise<void>;
  hover(sel: Selector): Promise<void>;
  scrollIntoView(sel: Selector): Promise<void>;
  upload(sel: Selector, filePath: string): Promise<void>;
  waitText(text: string, timeoutMs?: number): Promise<void>;
  screenshot(path: string, fullPage?: boolean): Promise<void>;
  dumpOuterHTML(truncateAt?: number): Promise<string>;
  listSelectors(max?: number): Promise<{
    testIds: string[];
    roles: { role: string; name: string | null; selector: string }[];
    texts: { text: string; selector: string }[];
  }>;
  waitForWindow(timeoutMs?: number, pick?: ConnectOptions['pick']): Promise<{ url: string; title: string }>;
  switchWindow(pick: ConnectOptions['pick']): Promise<{ url: string; title: string }>;
  flushConsole(): Promise<ConsoleEvent[]>;
  flushNetwork(): Promise<NetworkHarvest>;
  close(): Promise<void>;
}

// src/lib/playwright-driver.ts
export async function connectAndPick(opts: ConnectOptions): Promise<Driver>;

// src/lib/launch-electron.ts
export async function launchElectron(opts: LaunchOptions): Promise<LaunchResult>;
```

### 4.1 Playwright details (mandatory)

* Use `import { chromium } from 'playwright'`.
* Connect with `chromium.connectOverCDP(wsUrl)`.
* Enumerate contexts/pages from the connected browser; pick the renderer page using `pickTarget` scoring (preferred URL prefixes and `pick` filters).
* All actions use Playwright `Page`/`Locator`:
  * `click`: `locator.click()`
  * `type`: optional `locator.fill('')` then `locator.type(value)` (or `fill`) with `clearFirst`.
  * `waitText`: `page.getByText(text).waitFor({ state: 'visible', timeout })`.
  * `screenshot`: `page.screenshot({ path, fullPage })`.
  * `dumpOuterHTML`: `page.evaluate(() => document.documentElement.outerHTML)`.
  * `listSelectors`: evaluate in page to gather data-testid / role / text hints (same shape as before).
* Console capture: `page.on('console', ...)` and `page.on('pageerror', ...)` push into an array for `flushConsole`. Events emitted **before** the driver connects are not retroactively captured.
* Network capture: `page.on('requestfailed', …)` and `page.on('response', …)` (status ≥ 400) to fill `NetworkHarvest`; requests that finish before the driver attaches will not appear.

## 5) Optional test‑only IPC shims


## 6) Safety, timeouts, retries, cleanup

* Every command accepts `timeoutMs`; default 10s (launch: 40s).
* Retries for click/type: default 0; on retry, re‑resolve locator.
* **Artifacts** directory: configurable with `artifactDir` (default `.e2e-artifacts`) and `artifactPrefix` (default `<timestamp>`). Each run lives under `<artifactDir>/<artifactPrefix>/` plus a `last-run` symlink pointing to the most recent run _per dir_. Store:
  * Electron stdout/stderr (`launch-electron` helper) as `electron.stdout.log` / `electron.stderr.log`
  * `screenshot` outputs
  * `dom-snapshot` outputs (when requested)
  * harvested `console-harvest.json`, `network-harvest.json`
* **Shutdown** policy:
  * Consumer-owned: start and stop the app in your harness. The library/CLI do not manage process lifetime unless you opt into `launchElectron` / `launch-electron quit`.
* **Security**: CDP bound to `127.0.0.1`; enabled only when `E2E_CDP_PORT` is present; never ship enabled in production builds.

## 7) Repo layout

```
.
├─ src/
│  ├─ cli/browser-tools.ts        # dispatches subcommands
│  ├─ cli/launch-electron.ts      # optional launch/quit helper (JSON I/O)
│  ├─ cli/browser-tools.spec.mjs  # drives CLI against the fixture app
│  ├─ lib/playwright-driver.ts
│  └─ lib/types.ts
├─ examples/
│  ├─ smoke.mjs                   # API example
│  ├─ smoke.sh                    # CLI example (jq)
│  └─ dom-dump.mjs
├─ fixtures/                      # minimal Electron app for CI tests
│  ├─ main.js
│  ├─ preload.js
│  └─ index.html
├─ .github/workflows/
│  ├─ ci.yml
│  └─ release.yml
├─ biome.json
├─ tsconfig.json
├─ package.json
└─ README.md
```

## 8) Examples (shipped)

Same behaviors as before, but implemented with Playwright APIs. Examples launch the fixture themselves (e.g., `pnpm exec electron fixtures/main.js`) and use `getWsUrl` to obtain `wsUrl` before driving the app.

## 9) Fixture app for CI

Electron app under `fixtures` launched via `pnpm exec electron fixtures/main.js` (no separate package.json). It exposes:
* `click-button` (changes H1 to "Select a folder" and seeds text input).
* `hover-target` → sets `hover-output` text to `hovered` on mouseenter.
* `file-input` → echoes selected file name to `file-output`.
* A long page with `far-target` + `scroll-status` that flips to `scrolled` when the page scrolls.
* `open-window` button that opens `second.html` (titled "Second Window") for window helper tests.

## 10) Tests (run examples)

Same flow: install fixture deps, run `examples/smoke.js`, assert `.e2e-artifacts/smoke.png` exists. Examples may accept `LAUNCH_JSON` to skip launching inside the example.

## 11) CI (lint/format/build/test) — `.github/workflows/ci.yml`

Identical structure; ensure Playwright runtime deps available (Ubuntu: `npx playwright install --with-deps chromium` or rely on bundled chromium already installed by Playwright).

## 12) Release to npm — `.github/workflows/release.yml`

Uses **Changesets** automation on pushes to `main`:

- `changesets/action@v1` runs `pnpm version-packages` to bump versions and open a release PR (`commit: "chore: version packages"`, `title: "chore: release"`).
- When the PR is merged (or a manual publish is needed), it runs `pnpm release` (`pnpm build && pnpm changeset publish`) with npm provenance.
- Requires `NPM_TOKEN`; uses `GITHUB_TOKEN` for PR creation. Node 22 + pnpm 10 with cache enabled.
- `.changeset/config.json` is initialized with `baseBranch: "main"` and `access: "public"` so published packages are public by default.
- Local commands:
  - `pnpm changeset add` to record change entries (select bump + write summary).
  - `pnpm version-packages` to apply pending changesets and refresh the lockfile.
  - `pnpm release` to build and publish (respects npm provenance).

## 13) `package.json` (library)

Update dependencies to use Playwright:

```json
{
  "name": "electron-agent-tools",
  "version": "0.1.0",
  "description": "Playwright-based tools to launch and drive Electron apps (CLI + tiny TS API).",
  "type": "module",
  "license": "MIT",
  "engines": { "node": ">=18" },
  "exports": {
    ".": { "types": "./dist/lib/types.d.ts", "default": "./dist/index.js" },
    "./lib": { "types": "./dist/lib/types.d.ts", "default": "./dist/lib/index.js" }
  },
  "main": "dist/index.js",
  "types": "dist/lib/types.d.ts",
  "files": [ "dist", "README.md" ],
  "bin": {
    "launch-electron": "./dist/cli/launch-electron.js",
    "browser-tools": "./dist/cli/browser-tools.js"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "lint": "biome lint .",
    "format": "biome format --write .",
    "check": "biome ci . && tsc -p tsconfig.json --noEmit",
    "test": "node --test **/*.spec.js",
    "changeset": "changeset",
    "version-packages": "pnpm changeset version && pnpm install --no-frozen-lockfile",
    "release": "pnpm build && pnpm changeset publish"
  },
  "dependencies": {
    "playwright": "^<latest version>"
  },
  "devDependencies": {
    "@biomejs/biome": "^<latest version>",
    "@types/node": "^<latest version>",
    "typescript": "^<latest version>",
    "electron": "^<latest version>" // only for the fixture app in CI
  }
}
```

## 14) `tsconfig.json`

Unchanged unless Playwright types need additional libs (DOM already included).

## 15) `biome.json`

Unchanged.

## 16) README (short, human‑oriented)

Update language to say **Playwright-based** tooling; note that the automation connects with `chromium.connectOverCDP`.

## 17) Error codes (normative)

* `E_SPAWN`: failed to launch command.
* `E_EXIT_EARLY`: Electron process ended before CDP became reachable (includes exit code/signal and stderr log path).
* `E_CDP_TIMEOUT`: `/json/version` never exposed a WS URL within timeout.
* `E_NO_PAGE`: no renderer page target matched.
* `E_SELECTOR`: selector not found or not visible.
* `E_WAIT_TIMEOUT`: condition not met in time.
* `E_FS`: filesystem write failure.
* `E_IPC_GUARD`: IPC call attempted outside `NODE_ENV=test`.
* `E_INTERNAL`: unexpected error.
