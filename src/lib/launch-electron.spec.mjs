import assert from 'node:assert'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..', '..')
const electronBin = (() => {
  if (process.platform === 'win32') {
    return path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
  }
  return path.join(root, 'node_modules/.bin/electron')
})()
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
