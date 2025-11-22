import { writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { chromium } from 'playwright'

import { ensureArtifactPath, prepareArtifactRun } from '../lib/artifacts.js'
import { buildLocator, connectAndPick } from '../lib/playwright-driver.js'
import type { ArtifactOptions, Selector } from '../lib/types.js'

type JsonInput = Record<string, unknown>
type ParseResult =
  | { ok: true; sub: string; payload: JsonInput }
  | {
      ok: false
      error: {
        code: 'E_BAD_JSON'
        message: string
        details: { rawArg: string; parseError: string }
      }
    }

const printJson = (payload: unknown) => {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}

const fail = (code: string, message: string, details?: Record<string, unknown>) => {
  process.exitCode = 1
  printJson({ ok: false, error: { message, code, details } })
}

const parseArg = (): ParseResult => {
  const sub = process.argv[2] ?? ''
  const raw = process.argv[3] ?? process.argv[2] ?? ''
  let payload: JsonInput = {}
  if (raw) {
    try {
      payload = JSON.parse(raw)
    } catch (error) {
      return {
        ok: false,
        error: {
          code: 'E_BAD_JSON',
          message: 'Invalid JSON input',
          details: {
            rawArg: raw,
            parseError: error instanceof Error ? error.message : String(error),
          },
        },
      }
    }
  }
  return { ok: true, sub, payload }
}

const defaultTimeout = 10_000
const artifactOpts = (payload: JsonInput): ArtifactOptions => {
  const opts: ArtifactOptions = {}
  if (typeof payload.artifactDir === 'string') {
    opts.artifactDir = payload.artifactDir as string
  }
  if (typeof payload.artifactPrefix === 'string') {
    opts.artifactPrefix = payload.artifactPrefix as string
  }
  return opts
}

const prepareRun = async (payload: JsonInput) => prepareArtifactRun(artifactOpts(payload))

const listWindows = async (wsUrl: string) => {
  const browser = await chromium.connectOverCDP(wsUrl)
  const contexts = browser.contexts()
  const pages = contexts.flatMap((ctx) => ctx.pages())

  const pagesOut = []
  for (const page of pages) {
    const title = await page.title().catch(() => '')
    pagesOut.push({
      targetId: null,
      url: page.url(),
      title,
    })
  }

  await browser.close()
  return pagesOut
}

const run = async () => {
  const parsed = parseArg()
  if (!parsed.ok) {
    printJson(parsed)
    process.exitCode = 1
    return
  }
  const { sub, payload } = parsed
  const wsUrl = typeof payload.wsUrl === 'string' ? payload.wsUrl : ''
  const timeoutMs =
    typeof payload.timeoutMs === 'number' && payload.timeoutMs > 0
      ? payload.timeoutMs
      : defaultTimeout

  try {
    switch (sub) {
      case 'list-windows': {
        if (!wsUrl) throw new Error('wsUrl required')
        const pages = await listWindows(wsUrl)
        printJson({ ok: true, data: { pages } })
        return
      }
      case 'dom-snapshot': {
        if (!wsUrl) throw new Error('wsUrl required')
        const truncateAt =
          typeof payload.truncateAt === 'number' ? (payload.truncateAt as number) : undefined
        const driver = await connectAndPick({ wsUrl })
        const outerHTML = await driver.dumpOuterHTML(truncateAt)
        const page = driver.page
        const title = page?.title ? await page.title().catch(() => '') : ''
        const url = page?.url ? page.url() : ''
        await driver.close()

        const { dir } = await prepareRun(payload)
        const outPath = path.join(dir, 'dom-snapshot.html')
        await ensureArtifactPath(outPath)
        await writeFile(outPath, outerHTML, 'utf-8')

        printJson({ ok: true, data: { url, title, outerHTML } })
        return
      }
      case 'list-selectors': {
        if (!wsUrl) throw new Error('wsUrl required')
        const max = typeof payload.max === 'number' ? (payload.max as number) : undefined
        const driver = await connectAndPick({ wsUrl })
        const selectors = await driver.listSelectors(max)
        await driver.close()
        printJson({ ok: true, data: selectors })
        return
      }
      case 'wait-text': {
        if (!wsUrl || typeof payload.text !== 'string') throw new Error('wsUrl and text required')
        const driver = await connectAndPick({ wsUrl })
        await driver.waitText(payload.text as string, timeoutMs)
        await driver.close()
        printJson({ ok: true, data: { visible: true } })
        return
      }
      case 'press': {
        if (!wsUrl || typeof payload.key !== 'string') throw new Error('wsUrl and key required')
        const driver = await connectAndPick({ wsUrl })
        const { key, ...sel } = payload as Selector & { key: string }
        await driver.press(key, Object.keys(sel).length ? (sel as Selector) : undefined)
        await driver.close()
        printJson({ ok: true, data: { pressed: key } })
        return
      }
      case 'hover': {
        if (!wsUrl) throw new Error('wsUrl required')
        const driver = await connectAndPick({ wsUrl })
        await driver.hover(payload as Selector)
        await driver.close()
        printJson({ ok: true, data: { hovered: true } })
        return
      }
      case 'scroll-into-view': {
        if (!wsUrl) throw new Error('wsUrl required')
        const driver = await connectAndPick({ wsUrl })
        await driver.scrollIntoView(payload as Selector)
        await driver.close()
        printJson({ ok: true, data: { scrolled: true } })
        return
      }
      case 'upload': {
        if (!wsUrl || typeof payload.filePath !== 'string') {
          throw new Error('wsUrl and filePath required')
        }
        const driver = await connectAndPick({ wsUrl })
        const { filePath, ...sel } = payload as Selector & { filePath: string }
        await driver.upload(sel, filePath)
        await driver.close()
        printJson({ ok: true, data: { uploaded: filePath } })
        return
      }
      case 'click': {
        if (!wsUrl) throw new Error('wsUrl required')
        const driver = await connectAndPick({ wsUrl })
        await driver.click(payload as Selector)
        await driver.close()
        printJson({ ok: true, data: { clicked: true } })
        return
      }
      case 'type': {
        const hasValue = typeof payload.value === 'string'
        if (!wsUrl || !hasValue) {
          throw new Error('wsUrl and value required')
        }
        const driver = await connectAndPick({ wsUrl })
        await driver.type(payload as Selector & { value: string; clearFirst?: boolean })
        await driver.close()
        printJson({ ok: true, data: { typed: true } })
        return
      }
      case 'get-dom': {
        if (!wsUrl || typeof payload.as !== 'string') throw new Error('wsUrl and as required')
        const driver = await connectAndPick({ wsUrl })
        const locatorSel = payload as Selector & { as: 'innerHTML' | 'textContent' }
        const page = driver.page
        if (!page) throw new Error('E_NO_PAGE')
        const locator = buildLocator(page, locatorSel)
        const timeout =
          typeof locatorSel.timeoutMs === 'number' ? { timeout: locatorSel.timeoutMs } : undefined
        const value =
          locatorSel.as === 'innerHTML'
            ? await locator.innerHTML(timeout)
            : await locator.textContent(timeout)
        await driver.close()
        printJson({ ok: true, data: { value: value ?? '' } })
        return
      }
      case 'screenshot': {
        if (!wsUrl) throw new Error('wsUrl required')
        const fullPage = payload.fullPage !== false
        const pathArg =
          typeof payload.path === 'string'
            ? (payload.path as string)
            : path.join((await prepareRun(payload)).dir, 'page.png')
        await ensureArtifactPath(pathArg)
        const driver = await connectAndPick({ wsUrl })
        await driver.screenshot(pathArg, fullPage)
        await driver.close()
        printJson({ ok: true, data: { path: pathArg } })
        return
      }
      case 'console-harvest': {
        if (!wsUrl) throw new Error('wsUrl required')
        const driver = await connectAndPick({ wsUrl })
        const events = await driver.flushConsole()
        await driver.close()

        const { dir } = await prepareRun(payload)
        const outPath = path.join(dir, 'console-harvest.json')
        await ensureArtifactPath(outPath)
        await writeFile(outPath, JSON.stringify(events, null, 2), 'utf-8')

        printJson({ ok: true, data: { events } })
        return
      }
      case 'snapshot-globals': {
        if (!wsUrl || !Array.isArray((payload as JsonInput).names)) {
          throw new Error('wsUrl and names[] required')
        }
        const names = (payload as { names: unknown }).names as string[]
        const driver = await connectAndPick({ wsUrl })
        const snapshots = await driver.snapshotGlobals(names)
        await driver.close()
        printJson({ ok: true, data: { snapshots } })
        return
      }
      case 'ipc-harvest': {
        if (!wsUrl) throw new Error('wsUrl required')
        const driver = await connectAndPick({ wsUrl })
        await driver.enableIpcTracing(true)
        const events = await driver.flushIpc()
        await driver.close()

        const { dir } = await prepareRun(payload)
        const outPath = path.join(dir, 'ipc-harvest.json')
        await ensureArtifactPath(outPath)
        await writeFile(outPath, JSON.stringify(events, null, 2), 'utf-8')

        printJson({ ok: true, data: { events } })
        return
      }
      case 'dump-dom': {
        if (!wsUrl) throw new Error('wsUrl required')
        const sel = typeof payload.selector === 'string' ? (payload.selector as string) : undefined
        const truncateAt =
          typeof payload.truncateAt === 'number' ? (payload.truncateAt as number) : undefined
        const driver = await connectAndPick({ wsUrl })
        const out = await driver.dumpDOM(sel, truncateAt)
        await driver.close()
        const { dir } = await prepareRun(payload)
        const outPath = path.join(dir, 'dom-dump.html')
        await ensureArtifactPath(outPath)
        await writeFile(outPath, out.html, 'utf-8')

        printJson({ ok: true, data: out })
        return
      }
      case 'network-harvest': {
        if (!wsUrl) throw new Error('wsUrl required')
        const driver = await connectAndPick({ wsUrl })
        const harvest = await driver.flushNetwork()
        await driver.close()

        const { dir } = await prepareRun(payload)
        const outPath = path.join(dir, 'network-harvest.json')
        await ensureArtifactPath(outPath)
        await writeFile(outPath, JSON.stringify(harvest, null, 2), 'utf-8')

        printJson({ ok: true, data: harvest })
        return
      }
      case 'wait-for-window': {
        if (!wsUrl) throw new Error('wsUrl required')
        const pick =
          typeof payload.pick === 'object' && payload.pick
            ? (payload.pick as { titleContains?: string; urlIncludes?: string })
            : undefined
        const driver = await connectAndPick({ wsUrl })
        const win = await driver.waitForWindow(timeoutMs, pick)
        await driver.close()
        printJson({ ok: true, data: win })
        return
      }
      case 'switch-window': {
        if (!wsUrl) throw new Error('wsUrl required')
        const pick =
          typeof payload.pick === 'object' && payload.pick
            ? (payload.pick as { titleContains?: string; urlIncludes?: string })
            : {}
        const driver = await connectAndPick({ wsUrl })
        const win = await driver.switchWindow(pick)
        await driver.close()
        printJson({ ok: true, data: win })
        return
      }
      default: {
        fail('E_INTERNAL', `Unknown subcommand: ${sub}`)
        return
      }
    }
  } catch (error) {
    const code = (error as { code?: string }).code ?? 'E_INTERNAL'
    fail(code, 'Unexpected error', { error })
  }
}

await run()
