# SPEC — `electron-agent-tools` (MCP‑free, raw CDP)

> A tiny TypeScript library + CLI that lets humans or LLMs **launch and drive an Electron Forge app** via **Chrome DevTools Protocol (CDP)**—no MCP, no Playwright, no Spectron.

## 0) Goals & non‑goals

* **Goals**

  * Provide a **small registry of tools** (library APIs + CLI entrypoints) to launch, inspect, and drive an Electron app: click buttons, type, read DOM/HTML, capture screenshots, harvest console/network, optional test‑only IPC.
  * **Deterministic JSON I/O** for each CLI command; suitable for LLM orchestration.
  * **Raw CDP only** using `chrome-remote-interface` (no Playwright/Puppeteer/Spectron).
  * **Headless/background OK**; GUI visibility not required (use Xvfb in CI on Linux).
  * **Safety & cleanup** on failure/SIGINT; artifacts and logs collected.

* **Non‑goals**

  * Not a general test framework.
  * No MCP servers; no distributed runners.

## 1) Runtime & packaging

* **Node**: ≥ 18 (uses built‑in `fetch`), CI uses Node 20 LTS.
* **Package type**: ESM.
* **OS**: macOS, Windows, Linux. CI targets Linux with **Xvfb**.
* **Dependencies**:

  * runtime: `"chrome-remote-interface"` (raw CDP)
  * optional: `"tree-kill"` (or manual child cleanup)
* **Dev dependencies**: `"typescript"`, `"@types/node"`, `"@biomejs/biome"`.

## 2) Launch & connection model

* App is launched via a command (default `pnpm start:debug`), environment includes:

  * `E2E=1`, `NODE_ENV=test`, `E2E_CDP_PORT=<port>`, `ELECTRON_ENABLE_LOGGING=1`.
* App must enable CDP in **main**:

  ```ts
  import { app } from 'electron';
  if (process.env.E2E_CDP_PORT) {
    app.commandLine.appendSwitch('remote-debugging-port', process.env.E2E_CDP_PORT);
  }
  ```
* Launcher polls `http://127.0.0.1:<port>/json/version` until it sees `webSocketDebuggerUrl`, then returns it.
* Driver connects to the **browser** WS endpoint, enumerates **targets** (type `page`), and selects the main renderer:

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

General options (per command): `timeoutMs` (default 10000 unless noted), `retries` (default 0), `wsUrl` when a CDP connection is needed.

### 3.1 `launch-electron`

* **Purpose**: start the app, wait for CDP, return PID and WS URL.
* **Input**

  ```json
  { "port": 9223, "cwd": ".", "env": { }, "cmd": "pnpm start:debug", "timeoutMs": 40000 }
  ```
* **Output**

  ```json
  { "pid": 12345, "port": 9223, "wsUrl": "ws://127.0.0.1:9223/devtools/browser/...", "startedAt": "ISO", "logDir": ".e2e-artifacts/1700000000" }
  ```
* **Failure codes**: `E_SPAWN`, `E_CDP_TIMEOUT`, `E_PORT_IN_USE`.

### 3.2 `browser-tools <subcommand>`

Single binary dispatching subcommands; each takes a single JSON arg.

Subcommands and inputs:

* **`list-windows`** → `{ "wsUrl": "…" }`
  **Output**: `{ "pages":[ { "targetId","url","title" } ] }`

* **`dom-snapshot`** → `{ "wsUrl":"…", "truncateAt": 250000 }`
  **Output**: `{ "url","title","outerHTML" }`

* **`list-selectors`** → `{ "wsUrl":"…", "max":200 }`
  **Output**:

  ```json
  {
    "testIds": ["open-workspace-button", "..."],
    "roles": [ { "role":"button","name":"Open workspace","selector":"button" } ],
    "texts": [ { "text":"Open workspace","selector":"button" } ]
  }
  ```

* **`wait-text`** → `{ "wsUrl":"…", "text":"Open workspace", "timeoutMs":20000 }`
  **Output**: `{ "visible": true }`
  (Polls `document.body.innerText.includes(text)`.)

* **`click`** → selector schema (below)
  **Output**: `{ "clicked": true }`

* **`type`** → selector + `{ "value":"foo", "clearFirst":true }`
  **Output**: `{ "typed": true }`

* **`get-dom`** → selector + `{ "as":"innerHTML"|"textContent" }`
  **Output**: `{ "value": "…" }`

* **`screenshot`** → `{ "wsUrl":"…", "path":".e2e-artifacts/page.png", "fullPage": true }`
  **Output**: `{ "path":"…" }`

* **`console-harvest`** → `{ "wsUrl":"…" }`
  **Output**: `{ "events":[ { "type","text","ts" } ] }`

* **`network-harvest`** → `{ "wsUrl":"…" }`
  **Output**: `{ "failed":[urls], "errorResponses":[ { "url","status" } ] }`

* **`ipc-call`** (optional; test‑only) → `{ "wsUrl":"…", "channel":"app:quit", "args":{} }`
  **Output**: `{ "result": any }`
  Guards: only when `NODE_ENV=test`.

* **`quit`** → `{ "wsUrl":"…", "forceAfterMs":5000 }`
  **Output**: `{ "exited": true, "code": 0 }`
  Attempts IPC quit; falls back to SIGINT/kill.

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

**Resolution order**: `data-testid` → role/name → text substring → CSS.
**Visibility heuristic** (raw DOM): element exists, not `display:none`, not `visibility:hidden`, `opacity>0`, has a box (`getClientRects().length > 0`).

## 4) Library API (TypeScript)

```ts
// src/lib/types.ts
export type ConnectOptions = { wsUrl: string; pick?: { titleContains?: string; urlIncludes?: string } };

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

export interface Driver {
  click(sel: Selector): Promise<void>;
  type(sel: Selector & { value: string; clearFirst?: boolean }): Promise<void>;
  waitText(text: string, timeoutMs?: number): Promise<void>;
  screenshot(path: string, fullPage?: boolean): Promise<void>;
  dumpOuterHTML(truncateAt?: number): Promise<string>;
  listSelectors(max?: number): Promise<{
    testIds: string[];
    roles: { role: string; name: string | null; selector: string }[];
    texts: { text: string; selector: string }[];
  }>;
  flushConsole(): Promise<ConsoleEvent[]>;
  flushNetwork(): Promise<NetworkHarvest>;
  close(): Promise<void>;
}

// src/lib/cdp-driver.ts
export async function connectAndPick(opts: ConnectOptions): Promise<Driver>;
```

### 4.1 Raw CDP details (mandatory)

Use `chrome-remote-interface`:

* Connect to **browser endpoint** `wsUrl`.
* Use `Target.getTargets` to find renderer **page** target. Then `Target.attachToTarget` with `{ flatten: true }`.
* Enable domains on the page session: `Page.enable`, `Runtime.enable`, `DOM.enable`, `Network.enable`, `Log.enable`.
* Console: record from `Runtime.consoleAPICalled`, page errors from `Runtime.exceptionThrown` or `Log.entryAdded`.
* Network: collect `Network.loadingFailed` and `Network.responseReceived` (status ≥ 400).
* **DOM interactions**:

  * Resolve selector → run `Runtime.evaluate` to query element(s).
  * Click: `Runtime.evaluate` with `el.click()` when possible; fallback to `DOM.getBoxModel` + `Input.dispatchMouseEvent` at center.
  * Type: `Runtime.evaluate` with `el.focus()` then `Input.insertText` or set `.value` and dispatch `input`/`change`.
  * Wait‑text: poll every 200ms with a single `Runtime.evaluate` snippet `document.body.innerText.includes(text)`.
* Screenshot: `Page.captureScreenshot` (`fromSurface: true`). For “full page”, scroll to top and use `Emulation.setDeviceMetricsOverride` to page height, then restore.

**All CDP calls must be scoped to the *attached page session*.**

## 5) Optional test‑only IPC shims

* **Preload** (`src/preload.test.ts`):

  ```ts
  import { contextBridge, ipcRenderer } from 'electron';
  if (process.env.NODE_ENV === 'test') {
    contextBridge.exposeInMainWorld('__test', {
      ipcCall: (channel: string, args?: any) => ipcRenderer.invoke('test:call', { channel, args })
    });
  }
  ```
* **Main** (`src/main.test.ts`):

  ```ts
  import { app, ipcMain } from 'electron';
  if (process.env.NODE_ENV === 'test') {
    ipcMain.handle('test:call', async (_evt, { channel }) => {
      if (channel === 'app:quit') { app.quit(); return true; }
      throw new Error(`Unknown test channel: ${channel}`);
    });
  }
  ```

## 6) Safety, timeouts, retries, cleanup

* Every command accepts `timeoutMs`; default 10s (launch: 40s).
* Retries for click/type: default 0; on retry, re‑resolve selector and re‑check visibility.
* **Artifacts** directory: `.e2e-artifacts/<timestamp>/`. Store:

  * Electron stdout/stderr (`launch-electron`)
  * `screenshot` outputs
  * `dom-snapshot` outputs (when requested)
  * harvested `console-harvest.json`, `network-harvest.json`
* **Shutdown** policy:

  * Preferred: `ipc-call app:quit` (if enabled).
  * Else: SIGINT child; after `forceAfterMs`, SIGKILL (tree‑kill on Windows).
* **Security**: CDP bound to `127.0.0.1`; enabled only when `E2E_CDP_PORT` is present; never ship enabled in production builds.

## 7) Repo layout

```
.
├─ src/
│  ├─ cli/launch-electron.ts
│  ├─ cli/browser-tools.ts        # dispatches subcommands
│  ├─ lib/cdp-driver.ts
│  ├─ lib/types.ts
│  ├─ preload.test.ts             # optional
│  └─ main.test.ts                # optional
├─ examples/
│  ├─ smoke.mjs                   # API example
│  ├─ smoke.sh                    # CLI example (jq)
│  └─ dom-dump.mjs
├─ fixtures/mini-app/             # minimal Electron app for CI tests
│  ├─ package.json
│  ├─ main.ts
│  └─ index.html
├─ tests/
│  └─ examples.test.mjs           # runs the examples against the fixture app
├─ .github/workflows/
│  ├─ ci.yml
│  └─ release.yml
├─ biome.json
├─ tsconfig.json
├─ package.json
└─ README.md
```

## 8) Examples (shipped)

### `examples/smoke.mjs`

* Launch via CLI; connect with API; wait → click (by `data-testid`) → verify → screenshot → dump console/network.

### `examples/smoke.sh`

* Same as above via pure CLI; requires `jq`.

### `examples/dom-dump.mjs`

* Capture `outerHTML` and candidate selectors to `.e2e-artifacts`.

(You already saw these earlier; include them verbatim in the repo.)

## 9) Fixture app for CI

`fixtures/mini-app/package.json`

```json
{
  "name": "mini-electron-fixture",
  "private": true,
  "type": "module",
  "main": "main.ts",
  "scripts": {
    "start:debug": "NODE_ENV=test ELECTRON_ENABLE_LOGGING=1 electron ."
  },
  "devDependencies": {
    "electron": "^<latest version>",
    "typescript": "^<latest version>"
  }
}
```

`fixtures/mini-app/main.ts`

```ts
import { app, BrowserWindow } from "electron";
if (process.env.E2E_CDP_PORT) {
  app.commandLine.appendSwitch("remote-debugging-port", process.env.E2E_CDP_PORT!);
}
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 800, height: 600, webPreferences: { preload: undefined } });
  win.loadFile("index.html");
});
```

`fixtures/mini-app/index.html`

```html
<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>Mini</title></head>
  <body>
    <h1>Open workspace</h1>
    <button data-testid="open-workspace-button" onclick="
      document.querySelector('h1').textContent='Select a folder';
    ">Open workspace</button>
  </body>
</html>
```

## 10) Tests (run examples)

`tests/examples.test.mjs` (Node built‑in test runner)

```js
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const png = join(root, '.e2e-artifacts', 'smoke.png');

function run(cmd, args = [], env = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { env: { ...process.env, ...env } }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || stdout || String(err)));
      resolve({ stdout, stderr });
    });
    child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
  });
}

test('examples/smoke.mjs works against fixture', async () => {
  // Ensure pnpm installs in fixture on CI first time
  await run('pnpm', ['-C', 'fixtures/mini-app', 'install']);
  const launchArg = JSON.stringify({ port: 9223, cmd: 'pnpm -C fixtures/mini-app start:debug' });
  // The example accepts LAUNCH_JSON override via env for deterministic cmd (document this in README)
  await run('node', ['examples/smoke.mjs'], { LAUNCH_JSON: launchArg });
  await access(png); // file exists
});
```

> The example `examples/smoke.mjs` should honor an optional `process.env.LAUNCH_JSON` (when provided, skip calling `launch-electron` yourself and use it as the launch payload) **or** accept `cmd` in its invocation. Either approach is acceptable—document and implement one.

## 11) CI (lint/format/build/test) — `.github/workflows/ci.yml`

```yaml
name: CI
on:
  push:
    branches: [ main ]
  pull_request:
    branches: [ main ]

jobs:
  build-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v3
        with: { version: 10 }

      - name: Use Node.js 20
        uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: 'pnpm'
          registry-url: 'https://registry.npmjs.org'

      - name: Install deps
        run: pnpm install --frozen-lockfile

      - name: Biome (lint + format check)
        run: pnpm biome ci .

      - name: TypeScript build
        run: pnpm build

      # Electron needs a display on Linux; run tests under Xvfb
      - name: Run tests (examples)
        run: |
          sudo apt-get update
          sudo apt-get install -y xvfb
          xvfb-run -a pnpm test
```

## 12) Release to npm — `.github/workflows/release.yml`

* Publishes when you push a tag `v*.*.*`.
* Requires `NPM_TOKEN` (Automation token) in repo secrets.

```yaml
name: Release
on:
  push:
    tags: ['v*.*.*']

jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write  # for provenance
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v3
        with: { version: 10 }

      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: 'pnpm'
          registry-url: 'https://registry.npmjs.org'

      - name: Install & build
        run: |
          pnpm install --frozen-lockfile
          pnpm build

      - name: Publish to npm
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
        run: |
          npm publish --provenance --access public
```

> Release steps: bump version locally (`npm version patch|minor|major`), push tags (`git push --follow-tags`). The workflow publishes to npm.

## 13) `package.json` (library)

```json
{
  "name": "electron-agent-tools",
  "version": "0.1.0",
  "description": "MCP-free, raw CDP tools to launch and drive Electron apps (CLI + tiny TS API).",
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
    "test": "node --test tests/*.test.mjs"
  },
  "dependencies": {
    "chrome-remote-interface": "^<latest version>"
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

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM"],
    "module": "ES2022",
    "moduleResolution": "NodeNext",
    "rootDir": "src",
    "outDir": "dist",
    "declaration": true,
    "declarationMap": false,
    "skipLibCheck": true,
    "strict": true,
    "noEmitOnError": true
  },
  "include": ["src", "examples", "tests", "fixtures"]
}
```

## 15) `biome.json`

```json
{
  "$schema": "node_modules/@biomejs/biome/configuration_schema.json",
  "vcs": {
    "clientKind": "git",
    "useIgnoreFile": true
  },
  "files": {
    "includes": [
      "src/**",
      "examples/**",
      "tests/**",
      "fixtures/**",
      "scripts/**",
      ".github/**",
      "./*.json"
    ]
  },
  "formatter": {
    "enabled": true,
    "formatWithErrors": false,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineEnding": "lf",
    "lineWidth": 100,
    "attributePosition": "auto"
  },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true
    }
  },
  "assist": {
    "enabled": true,
    "actions": {
      "source": {
        "organizeImports": "on"
      }
    }
  },
  "javascript": {
    "formatter": {
      "quoteStyle": "single",
      "jsxQuoteStyle": "double",
      "quoteProperties": "asNeeded",
      "trailingCommas": "all",
      "semicolons": "asNeeded",
      "arrowParentheses": "always",
      "bracketSpacing": true
    }
  }
}
```

## 16) README (short, human‑oriented)

* What it is; quick start; how to wire CDP in your app; how to run examples; security note.
* Reuse the short README you already have; add a note:
  `pnpm -C fixtures/mini-app install && pnpm test` will run the examples in CI locally, too.

## 17) Error codes (normative)

* `E_SPAWN`: failed to launch command.
* `E_CDP_TIMEOUT`: `/json/version` never exposed a WS URL within timeout.
* `E_NO_PAGE`: no renderer page target matched.
* `E_SELECTOR`: selector not found or not visible/enabled.
* `E_WAIT_TIMEOUT`: condition not met in time.
* `E_FS`: filesystem write failure.
* `E_IPC_GUARD`: IPC call attempted outside `NODE_ENV=test`.
* `E_INTERNAL`: unexpected error.