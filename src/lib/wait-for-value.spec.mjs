import assert from 'node:assert'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..', '..')
const { AppError, PlaywrightDriver } = await import(
  pathToFileURL(path.join(root, 'dist/lib/playwright-driver.js')).href
)

const createDriver = () => {
  const fakeBrowser = {} // not used by waitForValue when context === 'page'
  const fakePage = {
    // mirrors the Playwright Page evaluate signature the helper expects
    async evaluate(fn) {
      return typeof fn === 'function' ? await fn() : fn
    },
  }

  // @ts-expect-error minimal fakes: waitForValue only needs page.evaluate
  return new PlaywrightDriver(fakeBrowser, fakePage, 'ws://dummy', null)
}

test('waitForValue resolves once fn returns non-nullish', async () => {
  const driver = createDriver()
  let attempts = 0

  const value = await driver.waitForValue(
    () => {
      attempts += 1
      return attempts >= 3 ? 'ready' : null
    },
    { context: 'page', pollMs: 5, timeoutMs: 200 },
  )

  assert.strictEqual(value, 'ready')
  assert.strictEqual(attempts, 3)
})

test('waitForValue captures last error message on timeout', async () => {
  const driver = createDriver()
  let attempts = 0

  await assert.rejects(
    driver.waitForValue(
      () => {
        attempts += 1
        throw new Error('boom')
      },
      { context: 'page', pollMs: 5, timeoutMs: 40, description: 'boom test' },
    ),
    (err) => {
      assert.ok(err instanceof AppError)
      assert.strictEqual(err.code, 'E_WAIT_TIMEOUT')
      assert.strictEqual(err.details?.lastError, 'boom')
      assert.strictEqual(err.details?.description, 'boom test')
      assert.ok(attempts > 1, 'should retry after errors')
      return true
    },
  )
})
