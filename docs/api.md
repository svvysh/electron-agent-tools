# Electron Agent Tools API

Reference for everything the package exposes: the TypeScript library _and_ the JSON-only CLIs. Paths are repo-relative; when installed from npm use the published binaries (e.g., `npm exec browser-tools -- …`).

## Library (TypeScript / ESM)

Import surface (`src/index.ts`):

```ts
import { getWsUrl, connectAndPick, launchElectron } from 'electron-agent-tools'
import type {
  ConnectOptions,
  Selector,
  Driver,
  ConsoleEvent,
  NetworkHarvest,
  WsOptions,
  LaunchOptions,
  LaunchResult,
  ArtifactOptions,
} from 'electron-agent-tools'
```

### `getWsUrl({ port, timeoutMs? }: WsOptions): Promise<string>`
- Polls `http://127.0.0.1:<port>/json/version` until `webSocketDebuggerUrl` is available.
- `timeoutMs` default: 30_000; rejects with an Error containing `details` on timeout.

### `launchElectron(opts: LaunchOptions): Promise<LaunchResult>`
- Spawns the Electron command, chooses/provides `cdpPort`, and waits for `wsUrl` before resolving.
- Captures stdout/stderr to `<artifactDir>/<artifactPrefix>/electron.stdout.log|electron.stderr.log`.
- Returns `{ wsUrl, pid, cdpPort, artifactDir, launchFile?, quit }`; `quit()` sends SIGINT/SIGTERM/KILL to the process group.
- Accepts `artifactDir` / `artifactPrefix` to align artifacts with CLI defaults.

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
- `waitForWindow(timeoutMs?: number, pick?: ConnectOptions['pick']): Promise<{ url; title }>` — Waits for an existing or newly opened window matching hints and rewires listeners to that page.
- `switchWindow(pick: ConnectOptions['pick']): Promise<{ url; title }>` — Chooses a window by `titleContains` / `urlIncludes` hints.
- `flushConsole(): Promise<ConsoleEvent[]>` — Returns and clears buffered console/pageerror events.
- `flushNetwork(): Promise<NetworkHarvest>` — Returns and clears buffered failed requests and 4xx/5xx responses.
- `close(): Promise<void>` — Closes the connected browser.

### `Selector` shape
- At least one of:
  - `testid: string` (data-testid)
  - `role: { role: string; name?: string }` (ARIA role; name can be string or regex compatible)
  - `text: string` (substring text match)
  - `css: string` (CSS selector)
- Optionals: `nth?: number` (0‑based), `timeoutMs?: number`.

### Event/harvest types
- `ConsoleEvent`: `{ type: string; text: string; ts: number }` (`page.on('console')` + `pageerror`).
- `NetworkHarvest`: `{ failed: string[]; errorResponses: { url: string; status: number }[] }`.

### Notes
- Selectors are resolved with Playwright locators in priority order: testid → role → text → css; then `nth` is applied.
- Errors from driver methods are wrapped as `AppError` with a `code` (e.g., `E_SELECTOR`, `E_WAIT_TIMEOUT`, `E_FS`).
- Console/network harvesting only records events after the driver connects; early app logs/requests may be missed if you attach late.

## CLI: `browser-tools`

Entry (npm install): `npm exec browser-tools -- <subcmd> '<json>'` (or `pnpm exec` / `yarn browser-tools`). All subcommands accept a single JSON argument; output is single-line JSON. On error: `{ ok: false, error: { code, message, details } }`.

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
- `console-harvest` — Input: `{ wsUrl }`. Writes `.e2e-artifacts/<ts>/console-harvest.json`; Output: `{ events }` (ConsoleEvent[]).
- `network-harvest` — Input: `{ wsUrl }`. Writes `.e2e-artifacts/<ts>/network-harvest.json`; Output: `NetworkHarvest`.
- `wait-for-window` — Input: `{ wsUrl, pick?, timeoutMs? }`. Output: `{ url, title }`.
- `switch-window` — Input: `{ wsUrl, pick }`. Output: `{ url, title }`.

### CLI: `launch-electron`
- `start|launch` — Input: `{ command, args?, cwd?, env?, headless?, cdpPort?, artifactDir?, artifactPrefix? }`. Output: `{ wsUrl, pid, electronPid, cdpPort, artifactDir, launchFile, quitHint }` (electronPid targets the actual Electron binary).
- `quit` — Input: `{ pid }` or `{ launchFile }`. Output: `{ quit: true, pid }`.

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

- Drive via CLI (pure JSON, good for shell/LLM):
```bash
WS_URL=$(node -e "import { getWsUrl } from 'electron-agent-tools'; (async () => console.log(await getWsUrl({ port: 9451 })))();")
npm exec browser-tools -- wait-text "{\"wsUrl\":\"$WS_URL\",\"text\":\"click button\"}"
npm exec browser-tools -- click "{\"wsUrl\":\"$WS_URL\",\"testid\":\"click-button\"}"
```
  - Substitute `pnpm exec` / `yarn browser-tools` if you use those managers.

## Error Conventions
- Library methods throw `AppError` with `code` and optional `details`.
- CLI always returns JSON; check `ok` boolean before consuming `data`.
