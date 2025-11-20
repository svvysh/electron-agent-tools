import assert from 'node:assert'
import { execFile } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..', '..')
const electronBin = path.join(root, 'node_modules/.bin/electron')

let built = false
const buildOnce = async () => {
  if (built) return
  await execFileAsync('pnpm', ['build'], { cwd: root, env: { ...process.env, NODE_ENV: 'test' } })
  built = true
}

const loadLib = () => import(pathToFileURL(path.join(root, 'dist/index.js')).href)

const countFds = async () => {
  const candidates = ['/proc/self/fd', '/dev/fd']
  for (const dir of candidates) {
    try {
      const entries = await readdir(dir)
      const numeric = entries.filter((e) => /^\d+$/.test(e))
      if (numeric.length) return numeric.length
    } catch {
      // try next
    }
  }
  return -1 // signal unsupported environment
}

test(
  'launchElectron closes log file descriptors between runs',
  { concurrency: false },
  async () => {
    await buildOnce()
    const { launchElectron } = await loadLib()

    const before = await countFds()

    for (let i = 0; i < 4; i += 1) {
      const launch = await launchElectron({
        command: electronBin,
        args: [path.join(root, 'fixtures/main.js')],
        artifactPrefix: `fd-leak-${i}`,
        headless: true,
      })
      await launch.quit()
    }

    const after = await countFds()

    if (before !== -1 && after !== -1) {
      assert.ok(after <= before + 2, `fd count grew unexpectedly: before=${before}, after=${after}`)
    }
  },
)
