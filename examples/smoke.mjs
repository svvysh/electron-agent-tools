import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { connectAndPick, getWsUrl } from 'electron-agent-tools'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const main = async () => {
  const port = 9333
  const electronBin = path.join(__dirname, '..', 'node_modules/.bin/electron')
  const child = spawn(electronBin, [path.join(__dirname, '..', 'fixtures/main.js')], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      E2E_CDP_PORT: String(port),
      E2E: '1',
      NODE_ENV: 'test',
      ELECTRON_ENABLE_LOGGING: '1',
    },
    stdio: 'ignore',
    detached: true,
  })

  // ensure child exits if parent exits
  const cleanup = () => {
    try {
      process.kill(-child.pid, 'SIGINT')
    } catch {
      /* ignore */
    }
  }
  process.on('exit', cleanup)
  process.on('SIGINT', cleanup)

  const wsUrl = await getWsUrl({ port, timeoutMs: 40_000 })
  const driver = await connectAndPick({ wsUrl })

  await driver.waitText('Open workspace', 20_000)
  await driver.click({ testid: 'open-workspace-button' })
  await driver.waitText('Select a folder', 20_000)
  await driver.screenshot('.e2e-artifacts/smoke.png', true)

  await driver.close()
  cleanup()
}

main()
