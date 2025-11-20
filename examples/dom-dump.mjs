import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { connectAndPick, getWsUrl } from '../dist/index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const launch = async () => {
  const port = 9334
  const child = spawn('pnpm', ['exec', 'electron', 'fixtures/main.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      E2E_CDP_PORT: String(port),
      E2E: '1',
      NODE_ENV: 'test',
      ELECTRON_ENABLE_LOGGING: '1',
    },
    stdio: 'ignore',
  })
  const wsUrl = await getWsUrl({ port, timeoutMs: 40_000 })
  return { child, wsUrl }
}

const main = async () => {
  const launchInfo = await launch()

  const driver = await connectAndPick({ wsUrl: launchInfo.wsUrl })
  const outerHTML = await driver.dumpOuterHTML(250_000)
  await writeFile('.e2e-artifacts/dom.html', outerHTML, 'utf-8')
  await driver.close()

  launchInfo.child.kill('SIGINT')
}

main()
