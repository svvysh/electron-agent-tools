# Electron Agent Tools API

Reference for everything the package exposes: the TypeScript library _and_ the JSON-only CLIs. Paths are repo-relative; when installed from npm use the published binaries (e.g., `npm exec browser-tools -- …`).

## Library (TypeScript / ESM)

Import surface (`src/index.ts`):

```ts
import { getWsUrl, connectAndPick, launchElectron, AppError, LaunchError } from 'electron-agent-tools'
import type {
  ConnectOptions,
  Selector,
  Driver,
  ConsoleEntry,
  NetworkHarvest,
  IpcTraceEntry,
  SnapshotPerWorld,
  WsOptions,
  LaunchOptions,
  LaunchResult,
  ArtifactOptions,
  AppErrorCode,
  LaunchErrorCode,
  ErrorCode,
} from 'electron-agent-tools'
```

### `getWsUrl({ port, timeoutMs? }: WsOptions): Promise<string>`
- Polls `http://127.0.0.1:<port>/json/version` until `webSocketDebuggerUrl` is available.
- Each poll request is aborted after ~1.5s so half-open ports can't stall the loop; overall timeout still applies.
- `timeoutMs` default: 30_000; rejects with an Error containing `details` on timeout.

### `launchElectron(opts: LaunchOptions): Promise<LaunchResult>`
- Spawns the Electron command, chooses/provides `cdpPort`, and waits for `wsUrl` before resolving.
- Captures stdout/stderr to `<artifactDir>/<artifactPrefix>/electron.stdout.log|electron.stderr.log`.
- Closes the log file descriptors when shutting down to avoid FD leaks across runs.
- Returns `{ wsUrl, pid, cdpPort, artifactDir, launchFile?, quit }`; `quit()` terminates the spawned tree (POSIX: SIGINT/SIGTERM/SIGKILL to the process group; Windows: `taskkill /T`).
- Accepts `artifactDir` / `artifactPrefix` to align artifacts with CLI defaults.
- If the Electron process errors or exits before CDP becomes reachable, the promise now rejects immediately (no 30–40s poll wait) with `LaunchError` code `E_SPAWN` (spawn error) or `E_EXIT_EARLY` (exit/close), including the exit `code`/`signal` and `stderrPath` in `details`.

### `connectAndPick(opts: ConnectOptions): Promise<Driver>`
- Uses `chromium.connectOverCDP` to attach to an already‑running Electron renderer.
- `ConnectOptions`:
  - `wsUrl` (string, required) — CDP websocket debugger URL (e.g. from `getWsUrl`).
  - `pick?: { titleContains?: string; urlIncludes?: string }` — optional scoring hints when multiple pages exist; scores also prefer `app://`, `file://`, and localhost origins.
- Returns a `Driver` (below). The underlying Playwright `Page` is exposed as `driver.page` (optional).

### `Driver` methods
- `click(sel: Selector): Promise<void>` — Clicks the first match. Respects `timeoutMs` on the selector; throws `E_SELECTOR` on failure.
- `type(sel: Selector & { value: string; clearFirst?: boolean }): Promise<void>` — Optionally clears, then fills. Honors `timeoutMs`.
- `press(key: string, sel?: Selector): Promise<void>` — Press a key globally or scoped to a locator.
- `hover(sel: Selector): Promise<void>` — Moves pointer to selector.
- `scrollIntoView(sel: Selector): Promise<void>` — Calls `scrollIntoView` on the element.
- `upload(sel: Selector, filePath: string): Promise<void>` — Uses `setInputFiles` on the locator.
- `waitText(text: string, timeoutMs = 10_000): Promise<void>` — Waits for visible text (substring match) or throws `E_WAIT_TIMEOUT`.
- `screenshot(path: string, fullPage = true): Promise<void>` — Ensures parent dirs exist, then writes PNG.
- `dumpOuterHTML(truncateAt?: number): Promise<string>` — Returns document.outerHTML, optionally truncated.
- `listSelectors(max = 200): Promise<{ testIds; roles; texts; }>` — Gathers top selectors from the document for quick discovery.
- `waitForWindow(timeoutMs?: number, pick?: ConnectOptions['pick']): Promise<{ url; title }>` — Waits for an existing or newly opened window matching hints and rewires listeners to that page. Safe to call while multiple contexts exist; background timeouts are cancelled so no unhandled rejections leak.
- `switchWindow(pick: ConnectOptions['pick']): Promise<{ url; title }>` — Chooses a window by `titleContains` / `urlIncludes` hints.
- `flushConsole(opts?: { sources?: ('main'|'preload'|'renderer'|'isolated'|'worker')[]; sinceTs?: number }): Promise<ConsoleEntry[]>` — Tagged console/log events from main + all renderer worlds.
- `flushNetwork(): Promise<NetworkHarvest>` — Returns and clears buffered failed requests and 4xx/5xx responses.
- `evalInRendererMainWorld / evalInIsolatedWorld / evalInPreload` — CDP evaluate helpers scoped to the exact JS world.
- `onRendererReload` / `onPreloadReady` — Lifecycle hooks to re-register globals across Vite/navigations.
- `waitForBridge(timeoutMs?)` — Polls preload for `__eatBridgeReady__`/`__eatTestHarness__`.
- `injectGlobals(globals, { persist?, worlds? })` — Deterministically replays helper objects into chosen worlds after reloads.
- `enableIpcTracing()` + `flushIpc()` — Wrap `ipcRenderer` to buffer channel/payload/duration/err metadata.
- `snapshotGlobals(names, { worlds? })` — Returns values per world for quick state inspection.
- `waitForTextAcrossReloads(text, { timeoutMs?, perAttemptTimeoutMs? })` — Retry-friendly wait that tolerates renderer reloads and captures DOM on failure.
- `dumpDOM(selector?, truncateAt?)` — Dumps `outerHTML` (optionally scoped) with url/title, used by wait helpers on timeout.
- `getRendererInspectorUrl()` — Builds a `devtools://…` URL pointing at the current renderer target for headless DevTools.
- `close(): Promise<void>` — Disconnects from the CDP session (leaves the Electron app running).

### `Selector` shape
- At least one of:
  - `testid: string` (data-testid)
  - `role: { role: string; name?: string }` (ARIA role; name can be string or regex compatible)
  - `text: string` (substring text match)
  - `css: string` (CSS selector)
- Optionals: `nth?: number` (0‑based), `timeoutMs?: number`.

### Event/harvest types
- `ConsoleEntry`: `{ source: 'main' | 'preload' | 'renderer' | 'isolated' | 'worker' | 'unknown', type: string, text: string, ts: number, args?, location? }` (CDP console + log with world tags).
- `NetworkHarvest`: `{ failed: string[]; errorResponses: { url: string; status: number }[] }`.
- `IpcTraceEntry`: `{ direction: 'renderer->main' | 'main->renderer', kind: 'send' | 'invoke' | 'event', channel: string, payload: unknown, durationMs?: number, error?: string, ts: number }`.

### Notes
- Selectors are resolved with Playwright locators in priority order: testid → role → text → css; then `nth` is applied.
- Errors from driver methods are wrapped as `AppError` with a `code` (e.g., `E_SELECTOR`, `E_WAIT_TIMEOUT`, `E_FS`).
- Console harvesting tags worlds via CDP and still only records after the driver connects; attach early (or launch via `launchElectron`) to capture the earliest logs.

## CLI: `browser-tools`

Entry (npm install): `npm exec browser-tools -- <subcmd> '<json>'` (or `pnpm exec` / `yarn browser-tools`). All subcommands accept a single JSON argument; output is single-line JSON. On error: `{ ok: false, error: { code, message, details } }`. Invalid JSON now fails fast (exit code 1) with:

```json
{ "ok": false, "error": { "code": "E_BAD_JSON", "message": "Invalid JSON input", "details": { "rawArg": "{not json", "parseError": "Unexpected token n in JSON at position 1" } } }
```

Common input keys:
- `wsUrl` (string, required for most) — CDP websocket URL.
- `timeoutMs` — overrides default 10_000 for wait/click/type selectors.
- Selectors follow the `Selector` shape above.
- `artifactDir` / `artifactPrefix` (for artifact-producing commands: dom-snapshot, screenshot, console-harvest, network-harvest).

Subcommands
- `list-windows` — Input: `{ wsUrl }`. Output: `{ ok: true, data: { pages: [{ targetId, url, title }] } }`.
- `dom-snapshot` — Input: `{ wsUrl, truncateAt? }`. Saves `.e2e-artifacts/<ts>/dom-snapshot.html`; Output includes `{ url, title, outerHTML }`.
- `list-selectors` — Input: `{ wsUrl, max? }`. Output: same shape as driver `listSelectors`.
- `wait-text` — Input: `{ wsUrl, text, timeoutMs? }`. Output: `{ ok: true, data: { visible: true } }`.
- `click` — Input: `{ wsUrl, ...Selector }`. Output: `{ clicked: true }`.
- `type` — Input: `{ wsUrl, value, clearFirst?, ...Selector }`. Output: `{ typed: true }`.
- `press` — Input: `{ wsUrl, key, ...Selector? }`. Output: `{ pressed: "key" }`.
- `hover` — Input: `{ wsUrl, ...Selector }`. Output: `{ hovered: true }`.
- `scroll-into-view` — Input: `{ wsUrl, ...Selector }`. Output: `{ scrolled: true }`.
- `upload` — Input: `{ wsUrl, filePath, ...Selector }`. Output: `{ uploaded: "filePath" }`.
- `get-dom` — Input: `{ wsUrl, as: 'innerHTML' | 'textContent', ...Selector }`. Output: `{ value: string }`.
- `screenshot` — Input: `{ wsUrl, path?, fullPage? }` (default path `.e2e-artifacts/<ts>/page.png`). Output: `{ path }`.
- `console-harvest` — Input: `{ wsUrl }`. Writes `.e2e-artifacts/<ts>/console-harvest.json`; Output: `{ events }` (ConsoleEntry[]).
- `snapshot-globals` — Input: `{ wsUrl, names: ["foo","bar"], worlds? }`. Output: `{ snapshots }` per world.
- `ipc-harvest` — Input: `{ wsUrl }`. Enables tracing (if not already) and dumps buffered IPC trace entries to artifact + stdout.
- `dump-dom` — Input: `{ wsUrl, selector?, truncateAt? }`. Writes `.e2e-artifacts/<ts>/dom-dump.html`; Output: `{ html, url, title }`.
- `network-harvest` — Input: `{ wsUrl }`. Writes `.e2e-artifacts/<ts>/network-harvest.json`; Output: `NetworkHarvest`.
- `wait-for-window` — Input: `{ wsUrl, pick?, timeoutMs? }`. Output: `{ url, title }`.
- `switch-window` — Input: `{ wsUrl, pick }`. Output: `{ url, title }`.

### CLI: `launch-electron`
- `start|launch` — Input: `{ command, args?, cwd?, env?, headless?, cdpPort?, artifactDir?, artifactPrefix? }`. Output: `{ wsUrl, pid, electronPid, cdpPort, artifactDir, launchFile, quitHint }` (electronPid is resolved by scanning descendant command lines for the launched Electron binary/helpers, with a fallback to the root pid).
- `quit` — Input: `{ pid }` or `{ launchFile }`. Output: `{ quit: true, pid }`. Terminates the spawned process tree (POSIX via process-group signals; Windows via `taskkill /T`).
- Both `launch-electron` commands share the same strict JSON parsing; malformed args return the `E_BAD_JSON` shape above and exit code 1.

Artifacts
- CLI writes under `<artifactDir>/<artifactPrefix>/` (defaults `.e2e-artifacts/<unix-ts>/`) with filenames: `dom-snapshot.html`, `console-harvest.json`, `network-harvest.json`, `page.png` (or custom path). A `last-run` symlink per dir points at the most recent run.

## Usage Recipes

- Discover a running app then drive it with the typed Driver:
```ts
const wsUrl = await getWsUrl({ port: 9451 })
const driver = await connectAndPick({ wsUrl })
await driver.waitText('Select a folder')
await driver.click({ testid: 'pick-folder' })
await driver.close()
```

`driver.close()` only detaches from the CDP session; the Electron process keeps running.

- Drive via CLI (pure JSON, good for shell/LLM):
```bash
WS_URL=$(node -e "import { getWsUrl } from 'electron-agent-tools'; (async () => console.log(await getWsUrl({ port: 9451 })))();")
npm exec browser-tools -- wait-text "{\"wsUrl\":\"$WS_URL\",\"text\":\"click button\"}"
npm exec browser-tools -- click "{\"wsUrl\":\"$WS_URL\",\"testid\":\"click-button\"}"
```
  - Substitute `pnpm exec` / `yarn browser-tools` if you use those managers.

## Error Conventions
- `AppError` (exported): `code` is one of `E_SELECTOR`, `E_NO_PAGE`, `E_WAIT_TIMEOUT`, `E_FS`, `E_INTERNAL`.
- `LaunchError` (exported): `code` is `E_SPAWN`, `E_EXIT_EARLY`, or `E_CDP_TIMEOUT`.
- `ErrorCode` (exported type) is the union of all library codes for easy narrowing.
- CLI always returns JSON; check `ok` boolean before consuming `data`.
- Recommended handling pattern:

```ts
try {
  await connectAndPick(...);
} catch (err) {
  if (err instanceof AppError || err instanceof LaunchError) {
    switch (err.code as ErrorCode) {
      case 'E_SELECTOR':
        // retry with a different locator, etc.
        break
      case 'E_EXIT_EARLY':
        // check stderrPath in err.details
        break
      default:
        throw err // rethrow unknown codes
    }
  }
  throw err
}
```
