#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT=9355
E2E=1 NODE_ENV=test E2E_CDP_PORT=$PORT ELECTRON_ENABLE_LOGGING=1 pnpm exec electron fixtures/main.js &
APP_PID=$!
trap "kill $APP_PID 2>/dev/null || true" EXIT

WS_URL=$(node --input-type=module - <<'NODE'
import { getWsUrl } from './dist/index.js';
const ws = await getWsUrl({ port: 9355, timeoutMs: 40000 });
console.log(ws);
NODE
)

node "$ROOT/dist/cli/browser-tools.js" wait-text \
  "{\"wsUrl\":\"$WS_URL\",\"text\":\"click button\",\"timeoutMs\":20000}"

node "$ROOT/dist/cli/browser-tools.js" click \
  "{\"wsUrl\":\"$WS_URL\",\"testid\":\"click-button\"}"

node "$ROOT/dist/cli/browser-tools.js" wait-text \
  "{\"wsUrl\":\"$WS_URL\",\"text\":\"Select a folder\",\"timeoutMs\":20000}"

node "$ROOT/dist/cli/browser-tools.js" screenshot \
  "{\"wsUrl\":\"$WS_URL\",\"path\":\".e2e-artifacts/smoke.png\",\"fullPage\":true}"
