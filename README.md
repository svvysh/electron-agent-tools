# electron-agent-tools

Playwright-based tools to drive Electron apps over CDP. Ships a tiny TypeScript API plus a JSON-only CLI (`browser-tools`) that work well for scripting or LLM orchestration.

## What you get
- **CLI**: `browser-tools <subcmd>` (click/type/wait/screenshot/harvest/etc).
- **Library**: `connectAndPick(opts)` returns a thin Driver around a Playwright `Page` using `chromium.connectOverCDP`.
- **Helper**: `getWsUrl({ port, timeoutMs })` polls CDP `/json/version` so you can connect after you launch the app yourself.
- **Selectors**: `data-testid → role/name → text → CSS`.
- **Artifacts**: `.e2e-artifacts/<timestamp>` for logs, screenshots, harvests (`last-run` symlink points to the latest timestamp).

## Install

```bash
pnpm add -D electron-agent-tools
```

## Examples

Run the smoke example against the bundled Electron fixture (located in `fixtures`):

```bash
pnpm build
node examples/smoke.mjs
```

Manual flow (you launch, then discover `wsUrl`; quitting is your responsibility):

```bash
E2E_CDP_PORT=9333 pnpm exec electron fixtures/main.js &
WS_URL=$(node -e "import { getWsUrl } from 'electron-agent-tools'; (async () => console.log(await getWsUrl({ port: 9333 })))();")
npx browser-tools wait-text "{\"wsUrl\":\"$WS_URL\",\"text\":\"Open workspace\"}"
npx browser-tools click "{\"wsUrl\":\"$WS_URL\",\"testid\":\"open-workspace-button\"}"
npx browser-tools screenshot "{\"wsUrl\":\"$WS_URL\",\"path\":\".e2e-artifacts/smoke.png\"}"
# when done, stop your Electron process (e.g., kill $PID)
```

See `examples/` for `smoke.mjs`, `smoke.sh`, and `dom-dump.mjs`.

## Development

```bash
pnpm install
pnpm build
pnpm check      # biome + typecheck
pnpm test       # runs examples against the fixture app (under Xvfb in CI)
```

## License

MIT
