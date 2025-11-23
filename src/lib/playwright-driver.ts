import { EventEmitter } from 'node:events'
import { mkdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { CDPSession } from 'playwright'
import {
  type Browser,
  chromium,
  type Locator,
  type Page,
  type Request,
  type Response,
} from 'playwright'
import type { AppErrorCode } from './error-codes.js'
import { defaultArtifactDir } from './artifacts.js'
import { type LogLevel, type LogSource, openRunLogger, type RunLogger } from './run-log.js'
import type { ConnectOptions, ConsoleSource, Driver, Selector, SnapshotPerWorld } from './types.js'

export class AppError extends Error {
  code: AppErrorCode
  details?: Record<string, unknown> | undefined

  constructor(code: AppErrorCode, message: string, details?: Record<string, unknown>) {
    super(message)
    this.code = code
    this.details = details
  }
}

const PREFERRED_PREFIXES = [
  'app://',
  'file://',
  'http://localhost',
  'https://localhost',
  'http://127.0.0.1',
]

const ensureDir = async (filePath: string) => {
  await mkdir(dirname(filePath), { recursive: true })
}

const classifyWorld = (auxData: Record<string, unknown> | undefined): ConsoleSource => {
  const type = typeof auxData?.type === 'string' ? (auxData.type as string) : ''
  const name = typeof auxData?.name === 'string' ? (auxData.name as string) : ''
  const isDefault = Boolean((auxData as { isDefault?: boolean } | undefined)?.isDefault)

  if (type === 'worker' || type === 'service_worker' || type === 'shared_worker') return 'worker'
  if (type === 'node') return 'main'
  if (type === 'isolated' && name.toLowerCase().includes('preload')) return 'preload'
  if (isDefault || type === 'default' || type === 'main') return 'renderer'
  if (type === 'isolated') return 'isolated'
  return 'unknown'
}

const mapConsoleLevel = (type: string | undefined): LogLevel => {
  if (type === 'warning') return 'warn'
  if (type === 'error') return 'error'
  if (type === 'debug') return 'debug'
  if (type === 'info') return 'info'
  return 'log'
}

type ContextInfo = { id: number; world: ConsoleSource; frameId?: string | undefined }

const serializeGlobals = (globals: Record<string, unknown>) => {
  return Object.fromEntries(
    Object.entries(globals).map(([key, value]) => {
      if (typeof value === 'function') {
        return [key, { kind: 'fn', source: value.toString() }]
      }
      return [key, { kind: 'value', value }]
    }),
  ) as Record<string, { kind: 'fn' | 'value'; source?: string; value?: unknown }>
}

const applyGlobalsSource = `function apply(globals) {
  try {
    for (const [key, entry] of Object.entries(globals ?? {})) {
      try {
        const value = entry && entry.kind === 'fn' && entry.source
          ? eval('(' + entry.source + ')')
          : entry && entry.kind === 'value'
            ? entry.value
            : undefined;
        // Attach to both globalThis and window when available
        try { globalThis[key] = value } catch {}
        try { if (typeof window !== 'undefined') window[key] = value } catch {}
      } catch {}
    }
  } catch {}
}`

const installIpcTracerSource = `function installTracer() {
  try {
    if (globalThis.__eatIpcTraceInstalled__) return true;
    const ipcRenderer = (globalThis && globalThis.ipcRenderer) || (typeof require === 'function' ? require('electron').ipcRenderer : undefined);
    if (!ipcRenderer) return false;
    const now = () => Date.now();
    const emit = (entry) => {
      try { console.info('__EAT_IPC__ ' + JSON.stringify({ ...entry, ts: now() })); } catch {}
    };

    const origSend = ipcRenderer.send.bind(ipcRenderer);
    ipcRenderer.send = (channel, ...args) => {
      const start = now();
      try {
        const result = origSend(channel, ...args);
        emit({ direction: 'renderer->main', kind: 'send', channel, payload: args, durationMs: now() - start });
        return result;
      } catch (error) {
        emit({ direction: 'renderer->main', kind: 'send', channel, payload: args, durationMs: now() - start, error: error?.message ?? String(error) });
        throw error;
      }
    };

    const origInvoke = ipcRenderer.invoke?.bind(ipcRenderer);
    if (origInvoke) {
      ipcRenderer.invoke = async (channel, ...args) => {
        const start = now();
        try {
          const result = await origInvoke(channel, ...args);
          emit({ direction: 'renderer->main', kind: 'invoke', channel, payload: args, durationMs: now() - start, result });
          return result;
        } catch (error) {
          emit({ direction: 'renderer->main', kind: 'invoke', channel, payload: args, durationMs: now() - start, error: error?.message ?? String(error) });
          throw error;
        }
      };
    }

    const origOn = ipcRenderer.on.bind(ipcRenderer);
    ipcRenderer.on = (channel, listener) => {
      const wrapped = (_event, ...args) => {
        emit({ direction: 'main->renderer', kind: 'event', channel, payload: args });
        return listener(_event, ...args);
      };
      return origOn(channel, wrapped);
    };

    globalThis.__eatIpcTraceInstalled__ = true;
    return true;
  } catch (error) {
    try { console.error('__EAT_IPC__ ' + JSON.stringify({ error: error?.message ?? String(error) })); } catch {}
    return false;
  }
}`

const scorePage = async (
  page: Page,
  pick?: ConnectOptions['pick'],
): Promise<{ score: number; title: string; url: string }> => {
  const url = page.url()
  let title = ''
  try {
    title = await page.title()
  } catch {
    title = ''
  }

  let score = 0
  if (PREFERRED_PREFIXES.some((p) => url.startsWith(p))) {
    score += 5
  }
  if (pick?.urlIncludes && url.includes(pick.urlIncludes)) {
    score += 4
  }
  if (pick?.titleContains && title.includes(pick.titleContains)) {
    score += 4
  }
  return { score, title, url }
}

export const buildLocator = (page: Page, sel: Selector): Locator => {
  let locator: Locator | null = null
  if (sel.testid) {
    locator = page.getByTestId(sel.testid)
  } else if (sel.role) {
    const roleOptions =
      sel.role.name !== undefined ? { name: sel.role.name as string | RegExp } : {}
    locator = page.getByRole(sel.role.role as never, roleOptions)
  } else if (sel.text) {
    locator = page.getByText(sel.text, { exact: false })
  } else if (sel.css) {
    locator = page.locator(sel.css)
  }

  if (!locator) {
    throw new AppError('E_SELECTOR', 'No selector provided')
  }

  return locator.nth(sel.nth ?? 0)
}

class PlaywrightDriver implements Driver {
  #browser: Browser
  #page: Page
  #browserSession: CDPSession | null = null
  #pageSessions: Map<Page, { session: CDPSession; contexts: Map<number, ContextInfo> }> = new Map()
  #emitter = new EventEmitter()
  #injectors: Array<{
    worlds: Set<'renderer' | 'isolated' | 'preload'>
    payload: Record<string, { kind: 'fn' | 'value'; source?: string; value?: unknown }>
  }> = []
  #logger: RunLogger | null
  #listeners = {
    pageerror: (error: Error) => {
      this.#log('renderer', 'error', error.message)
    },
    requestfailed: (request: Request) => {
      const url = request.url()
      if (url) {
        this.#log('network', 'warn', 'request-failed', {
          url,
          method: request.method(),
          error: request.failure()?.errorText,
        })
      }
    },
    response: (response: Response) => {
      if (response.status() >= 400) {
        this.#log('network', 'warn', 'response>=400', {
          url: response.url(),
          status: response.status(),
          method: response.request().method(),
        })
      }
    },
  }

  #wsUrl: string

  constructor(browser: Browser, page: Page, wsUrl: string, logger: RunLogger | null) {
    this.#browser = browser
    this.#page = page
    this.#wsUrl = wsUrl
    this.#logger = logger
  }

  #log(source: LogSource, level: LogLevel, message: string, meta?: Record<string, unknown>) {
    this.#logger?.log(source, level, message, meta)
  }

  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: Bug in biome
  async #init() {
    this.#wireEvents(this.#page)
    await this.#wirePageSession(this.#page)
    await this.#wireBrowserSession()
  }

  #wireEvents(page: Page) {
    page.on('pageerror', this.#listeners.pageerror)
    page.on('requestfailed', this.#listeners.requestfailed)
    page.on('response', this.#listeners.response)
  }

  #unwireEvents(page?: Page) {
    if (!page) return
    page.off('pageerror', this.#listeners.pageerror)
    page.off('requestfailed', this.#listeners.requestfailed)
    page.off('response', this.#listeners.response)
  }

  async #wirePageSession(page: Page) {
    if (this.#pageSessions.has(page)) return
    const session = await page.context().newCDPSession(page)
    const contexts: Map<number, ContextInfo> = new Map()

    session.on('Runtime.executionContextCreated', (event) => {
      const ctx = event.context
      let world = classifyWorld(ctx?.auxData)
      const isPlaywrightUtility = ctx?.name?.startsWith('__playwright_utility_world')

      if (ctx?.name?.includes('Electron Isolated Context')) {
        world = 'preload'
      }

      // If we see the first non-utility isolated context, treat it as preload to make bridge waits resilient.
      const hasPreload = Array.from(contexts.values()).some((c) => c.world === 'preload')
      if (world === 'isolated' && !hasPreload && !isPlaywrightUtility) {
        world = 'preload'
      }

      contexts.set(ctx?.id as number, {
        id: ctx?.id as number,
        world,
        frameId:
          typeof ctx?.auxData === 'object' && ctx?.auxData && 'frameId' in ctx.auxData
            ? ((ctx.auxData as { frameId?: unknown }).frameId as string | undefined)
            : undefined,
      })
      if (world === 'preload') {
        this.#emitter.emit('preload-ready')
      }
      // apply persistent injectors for this world
      this.#applyInjectorsToContext(session, ctx?.id as number, world).catch(() => {})
      if (world === 'preload') {
        this.#installIpcTracer(session, ctx?.id as number).catch(() => {})
      }
    })

    session.on('Runtime.consoleAPICalled', (event) => {
      const ctxInfo = contexts.get(event.executionContextId ?? -1)
      let source = ctxInfo?.world ?? 'unknown'
      const text = (event.args ?? [])
        .map((arg) =>
          arg?.value !== undefined ? arg.value : (arg?.description ?? arg?.unserializableValue),
        )
        .join(' ')
      const firstFrame = event.stackTrace?.callFrames?.[0]
      const location = firstFrame?.url
        ? {
            url: firstFrame.url,
            ...(firstFrame.lineNumber !== undefined ? { lineNumber: firstFrame.lineNumber } : {}),
            ...(firstFrame.columnNumber !== undefined
              ? { columnNumber: firstFrame.columnNumber }
              : {}),
          }
        : undefined
      const raw = text.toString()
      const ipcPrefix = '__EAT_IPC__'
      if (raw.startsWith(ipcPrefix)) {
        const payload = raw.slice(ipcPrefix.length).trimStart()
        try {
          const parsed = JSON.parse(payload) as {
            direction?: string
            kind?: string
            channel?: string
            durationMs?: number
            error?: string
            result?: unknown
            payload?: unknown
          }
          this.#log('ipc', parsed.error ? 'error' : 'info', 'ipc-trace', {
            direction: parsed.direction,
            kind: parsed.kind,
            channel: parsed.channel,
            durationMs: parsed.durationMs,
            error: parsed.error,
          })
        } catch {
          this.#log('ipc', 'info', raw)
        }
        return
      }
      if (location?.url?.includes('electron/js2c/renderer_init')) {
        source = 'preload'
      }
      this.#log(source as LogSource, mapConsoleLevel(event.type), raw, {
        url: location?.url,
        line: location?.lineNumber,
        column: location?.columnNumber,
      })
    })

    session.on('Log.entryAdded', (event) => {
      const location = event.entry?.url
        ? {
            url: event.entry.url,
            ...(event.entry.lineNumber !== undefined ? { lineNumber: event.entry.lineNumber } : {}),
            ...('columnNumber' in event.entry &&
            typeof event.entry.columnNumber === 'number' &&
            event.entry.columnNumber !== null &&
            event.entry.columnNumber !== undefined
              ? { columnNumber: event.entry.columnNumber }
              : {}),
          }
        : undefined
      const source = classifyWorld(
        event?.entry?.source === 'worker' ? { type: 'worker' } : { type: 'renderer' },
      )
      this.#log(source as LogSource, mapConsoleLevel(event.entry.level), event.entry.text, {
        url: location?.url,
        line: location?.lineNumber,
        column: location?.columnNumber,
      })
    })

    await session.send('Runtime.enable')
    await session.send('Log.enable').catch(() => {})
    await session.send('Page.enable').catch(() => {})

    // Track reloads on the main frame
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        this.#emitter.emit('renderer-reload')
        this.#log('system', 'info', 'renderer-reload', { url: frame.url() })
      }
    })

    page.on('close', () => {
      this.#pageSessions.delete(page)
      this.#log('system', 'info', 'page-closed')
    })

    this.#pageSessions.set(page, { session, contexts })
  }
  #getPageSession(page?: Page) {
    const current = page ?? this.#page
    return this.#pageSessions.get(current)
  }

  #findContextId(world: 'renderer' | 'isolated' | 'preload' | 'main' | 'worker' | 'unknown') {
    const info = this.#getPageSession()
    if (!info) return null
    for (const ctx of info.contexts.values()) {
      if (ctx.world === world) return ctx.id
    }
    return null
  }

  async #applyInjectorsToContext(
    session: CDPSession,
    contextId: number,
    world: ConsoleSource,
  ): Promise<void> {
    const injectors = this.#injectors.filter((inj) => inj.worlds.has(world as never))
    for (const inj of injectors) {
      await session
        .send('Runtime.callFunctionOn', {
          executionContextId: contextId,
          functionDeclaration: applyGlobalsSource,
          arguments: [{ value: inj.payload }],
          returnByValue: true,
        })
        .catch(() => {})
    }
  }

  async #installIpcTracer(session: CDPSession, contextId: number) {
    await session
      .send('Runtime.callFunctionOn', {
        executionContextId: contextId,
        functionDeclaration: installIpcTracerSource,
        returnByValue: true,
      })
      .catch(() => {})
  }

  async #evalInContext<T>(
    world: 'renderer' | 'isolated' | 'preload' | 'main' | 'worker' | 'unknown',
    fn: ((...args: unknown[]) => T) | string,
    arg?: unknown,
  ): Promise<T> {
    if (world === 'main') {
      if (!this.#browserSession) throw new AppError('E_INTERNAL', 'No main process session')
      const expression =
        typeof fn === 'function' ? `(${fn.toString()})(${JSON.stringify(arg)})` : String(fn)
      const { result, exceptionDetails } = (await this.#browserSession.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      })) as { result?: { value?: unknown }; exceptionDetails?: { text?: string } }
      if (exceptionDetails) {
        throw new AppError('E_INTERNAL', exceptionDetails.text ?? 'Evaluation failed', {
          exceptionDetails,
        })
      }
      return result?.value as T
    }

    const info = this.#getPageSession()
    if (!info) throw new AppError('E_NO_PAGE', 'No renderer session attached')
    const ctxId = this.#findContextId(world)
    if (!ctxId) throw new AppError('E_NO_PAGE', `No ${world} execution context available`)

    const session = info.session
    if (typeof fn === 'function') {
      const { result, exceptionDetails } = (await session.send('Runtime.callFunctionOn', {
        executionContextId: ctxId,
        functionDeclaration: fn.toString(),
        arguments: arg !== undefined ? [{ value: arg }] : [],
        returnByValue: true,
        awaitPromise: true,
      })) as { result?: { value?: unknown }; exceptionDetails?: { text?: string } }
      if (exceptionDetails) {
        throw new AppError('E_INTERNAL', exceptionDetails.text ?? 'Evaluation failed', {
          exceptionDetails,
        })
      }
      return result?.value as T
    }

    const { result, exceptionDetails } = (await session.send('Runtime.evaluate', {
      contextId: ctxId,
      expression: String(fn),
      returnByValue: true,
      awaitPromise: true,
    })) as { result?: { value?: unknown }; exceptionDetails?: { text?: string } }
    if (exceptionDetails) {
      throw new AppError('E_INTERNAL', exceptionDetails.text ?? 'Evaluation failed', {
        exceptionDetails,
      })
    }
    return result?.value as T
  }

  async #wireBrowserSession() {
    try {
      const sessionAny = await this.#browser.newBrowserCDPSession()
      const session = sessionAny as CDPSession
      this.#browserSession = session
    } catch {
      this.#browserSession = null
      return
    }
    if (!this.#browserSession) return

    this.#browserSession.on('Runtime.consoleAPICalled', (event) => {
      this.#log(
        'main',
        mapConsoleLevel(event?.type),
        (event?.args ?? []).map((arg) => arg?.value ?? arg?.description ?? '').join(' '),
        { ts: Math.round((event?.timestamp ?? Date.now() / 1000) * 1000) },
      )
    })

    this.#browserSession.on('Log.entryAdded', (event) => {
      const location = event.entry?.url
        ? {
            url: event.entry.url,
            ...(event.entry.lineNumber !== undefined ? { lineNumber: event.entry.lineNumber } : {}),
            ...('columnNumber' in event.entry &&
            typeof event.entry.columnNumber === 'number' &&
            event.entry.columnNumber !== null &&
            event.entry.columnNumber !== undefined
              ? { columnNumber: event.entry.columnNumber }
              : {}),
          }
        : undefined
      this.#log('main', mapConsoleLevel(event.entry.level), event.entry.text, {
        ts: Math.round(event.entry.timestamp * 1000),
        url: location?.url,
        line: location?.lineNumber,
        column: location?.columnNumber,
      })
    })

    await this.#browserSession.send('Runtime.enable').catch(() => {})
    await this.#browserSession.send('Log.enable').catch(() => {})
  }

  #setPage(page: Page) {
    this.#unwireEvents(this.#page)
    this.#page = page
    // wire Playwright network listeners
    this.#wireEvents(page)
    // ensure CDP session exists
    this.#wirePageSession(page).catch(() => {})
  }

  /** Expose underlying Playwright page (primarily for CLI plumbing). */
  get page(): Page {
    return this.#page
  }

  static async create(opts: ConnectOptions): Promise<PlaywrightDriver> {
    const browser = await chromium.connectOverCDP(opts.wsUrl)
    const contexts = browser.contexts()
    const pages = contexts.flatMap((ctx) => ctx.pages())
    const runLogPath = opts.runLogPath ?? join(defaultArtifactDir, 'last-run', 'run.log')
    const logger = openRunLogger(dirname(runLogPath), basename(runLogPath))

    if (pages.length === 0) {
      await browser.close()
      throw new AppError('E_NO_PAGE', 'No renderer pages available')
    }

    let best: { page: Page; score: number } | null = null
    for (const page of pages) {
      const { score } = await scorePage(page, opts.pick)
      if (!best || score > best.score) {
        best = { page, score }
      }
    }

    if (!best) {
      await browser.close()
      throw new AppError('E_NO_PAGE', 'Unable to pick a renderer page')
    }

    const driver = new PlaywrightDriver(browser, best.page, opts.wsUrl, logger)
    await driver.#init()
    driver.#log('system', 'info', 'driver-connected', {
      wsUrl: opts.wsUrl,
      pageUrl: best.page.url(),
    })
    return driver
  }

  async #pickBestPage(
    pick?: ConnectOptions['pick'],
    requireMatch = false,
  ): Promise<{ page: Page; title: string; url: string } | null> {
    const contexts = this.#browser.contexts()
    const pages = contexts.flatMap((ctx) => ctx.pages())
    let best: { page: Page; title: string; url: string; score: number } | null = null
    for (const page of pages) {
      const { score, title, url } = await scorePage(page, pick)
      const matchesPick =
        !pick || !requireMatch
          ? true
          : Boolean(
              (pick.titleContains ? title.includes(pick.titleContains) : true) &&
                (pick.urlIncludes ? url.includes(pick.urlIncludes) : true),
            )

      if (requireMatch && !matchesPick) continue

      if (!best || score > best.score) {
        best = { page, title, url, score }
      }
    }
    return best ? { page: best.page, title: best.title, url: best.url } : null
  }

  async click(sel: Selector): Promise<void> {
    const locator = buildLocator(this.#page, sel)
    try {
      const opts = sel.timeoutMs !== undefined ? { timeout: sel.timeoutMs } : undefined
      await locator.click(opts)
    } catch (error) {
      throw new AppError('E_SELECTOR', 'Failed to click selector', { error })
    }
  }

  async type(sel: Selector & { value: string; clearFirst?: boolean }): Promise<void> {
    const locator = buildLocator(this.#page, sel)
    try {
      if (sel.clearFirst) {
        const clearOpts = sel.timeoutMs !== undefined ? { timeout: sel.timeoutMs } : undefined
        await locator.fill('', clearOpts)
      }
      const fillOpts = sel.timeoutMs !== undefined ? { timeout: sel.timeoutMs } : undefined
      await locator.fill(sel.value, fillOpts)
    } catch (error) {
      throw new AppError('E_SELECTOR', 'Failed to type into selector', { error })
    }
  }

  async press(key: string, sel?: Selector): Promise<void> {
    try {
      if (sel) {
        const locator = buildLocator(this.#page, sel)
        const opts = sel.timeoutMs !== undefined ? { timeout: sel.timeoutMs } : undefined
        await locator.press(key, opts)
      } else {
        await this.#page.keyboard.press(key)
      }
    } catch (error) {
      throw new AppError('E_SELECTOR', `Failed to press ${key}`, { error })
    }
  }

  async hover(sel: Selector): Promise<void> {
    const locator = buildLocator(this.#page, sel)
    try {
      const opts = sel.timeoutMs !== undefined ? { timeout: sel.timeoutMs } : undefined
      await locator.hover(opts)
    } catch (error) {
      throw new AppError('E_SELECTOR', 'Failed to hover selector', { error })
    }
  }

  async scrollIntoView(sel: Selector): Promise<void> {
    const locator = buildLocator(this.#page, sel)
    try {
      await locator.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'center' }))
    } catch (error) {
      throw new AppError('E_SELECTOR', 'Failed to scroll element into view', { error })
    }
  }

  async upload(sel: Selector, filePath: string): Promise<void> {
    const locator = buildLocator(this.#page, sel)
    try {
      await locator.setInputFiles(filePath)
    } catch (error) {
      throw new AppError('E_SELECTOR', 'Failed to upload file', { error })
    }
  }

  async waitText(text: string, timeoutMs = 10_000): Promise<void> {
    try {
      const locator = this.#page.getByText(text, { exact: false }).first()
      await locator.waitFor({
        state: 'visible',
        timeout: timeoutMs,
      })
    } catch (error) {
      throw new AppError('E_WAIT_TIMEOUT', `Text "${text}" not visible in time`, { error })
    }
  }

  async screenshot(path: string, fullPage = true): Promise<void> {
    await ensureDir(path)
    try {
      await this.#page.screenshot({ path, fullPage })
      this.#log('screenshot', 'info', 'screenshot', { path, fullPage })
    } catch (error) {
      throw new AppError('E_FS', 'Failed to capture screenshot', { error })
    }
  }

  async dumpOuterHTML(truncateAt?: number): Promise<string> {
    try {
      const html = await this.#page.evaluate(() => document.documentElement?.outerHTML ?? '')
      if (truncateAt && html.length > truncateAt) {
        return html.slice(0, truncateAt)
      }
      return html
    } catch (error) {
      throw new AppError('E_INTERNAL', 'Failed to read DOM', { error })
    }
  }

  async listSelectors(max = 200): Promise<{
    testIds: string[]
    roles: { role: string; name: string | null; selector: string }[]
    texts: { text: string; selector: string }[]
  }> {
    try {
      return await this.#page.evaluate((limit) => {
        const uniq = <T>(arr: T[]) => Array.from(new Set(arr)).slice(0, limit)
        const testIds = uniq(
          Array.from(document.querySelectorAll('[data-testid]'))
            .map((el) => el.getAttribute('data-testid'))
            .filter((v): v is string => Boolean(v)),
        )

        const roleElements = Array.from(document.querySelectorAll('[role]')).slice(0, limit)
        const roles = roleElements.map((el) => ({
          role: (el.getAttribute('role') ?? '').trim(),
          name: (el.getAttribute('aria-label') ?? el.textContent ?? '').trim() || null,
          selector: el.tagName.toLowerCase(),
        }))

        const textEls = Array.from(
          document.querySelectorAll('button, a, h1, h2, h3, p, span'),
        ).slice(0, limit)
        const texts = textEls
          .map((el) => ({
            text: (el.textContent ?? '').trim(),
            selector: el.tagName.toLowerCase(),
          }))
          .filter((item) => item.text.length > 0)
          .slice(0, limit)

        return { testIds, roles, texts }
      }, max)
    } catch (error) {
      throw new AppError('E_INTERNAL', 'Failed to list selectors', { error })
    }
  }

  async waitForWindow(
    timeoutMs = 10_000,
    pick?: ConnectOptions['pick'],
  ): Promise<{ url: string; title: string }> {
    const mustMatch = Boolean(pick?.titleContains || pick?.urlIncludes)
    const existing = await this.#pickBestPage(pick, mustMatch)
    if (existing) {
      if (existing.page !== this.#page) {
        this.#setPage(existing.page)
      }
      return { url: existing.url, title: existing.title }
    }

    const contexts = this.#browser.contexts()
    const waiters = contexts.map((ctx) => {
      let cancelled = false
      const promise = ctx
        .waitForEvent('page', { timeout: timeoutMs })
        .then((page) => (cancelled ? null : page))
        .catch((error) => {
          if (cancelled) return null
          throw error
        })

      return {
        promise,
        cancel: () => {
          cancelled = true
        },
      }
    })

    try {
      const newPage = await Promise.race(waiters.map((waiter) => waiter.promise))
      // Cancel losers so their eventual timeouts resolve quietly instead of rejecting unhandled.
      waiters.forEach((waiter) => {
        waiter.cancel()
      })

      if (!newPage) {
        throw new AppError('E_WAIT_TIMEOUT', 'No matching window appeared in time')
      }
      const { title, url } = await scorePage(newPage, pick)
      await this.#wirePageSession(newPage)
      this.#setPage(newPage)
      return { url, title }
    } catch (error) {
      waiters.forEach((waiter) => {
        waiter.cancel()
      })
      throw new AppError('E_WAIT_TIMEOUT', 'No matching window appeared in time', { error })
    }
  }

  async switchWindow(pick: ConnectOptions['pick']): Promise<{ url: string; title: string }> {
    const mustMatch = Boolean(pick?.titleContains || pick?.urlIncludes)
    const best = await this.#pickBestPage(pick, mustMatch)
    if (!best) {
      throw new AppError('E_NO_PAGE', 'No window matched the criteria')
    }

    await this.#wirePageSession(best.page)
    this.#setPage(best.page)
    return { url: best.url, title: best.title }
  }

  async evalInRendererMainWorld<T = unknown>(
    fn: (...args: unknown[]) => T,
    arg?: unknown,
  ): Promise<T> {
    return this.#evalInContext('renderer', fn, arg)
  }

  async evalInIsolatedWorld<T = unknown>(fn: (...args: unknown[]) => T, arg?: unknown): Promise<T> {
    return this.#evalInContext('isolated', fn, arg)
  }

  async evalInPreload<T = unknown>(fn: (...args: unknown[]) => T, arg?: unknown): Promise<T> {
    return this.#evalInContext('preload', fn, arg)
  }

  onRendererReload(cb: () => void): () => void {
    this.#emitter.on('renderer-reload', cb)
    return () => this.#emitter.off('renderer-reload', cb)
  }

  onPreloadReady(cb: () => void): () => void {
    this.#emitter.on('preload-ready', cb)
    return () => this.#emitter.off('preload-ready', cb)
  }

  async waitForBridge(timeoutMs = 10_000): Promise<void> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      try {
        await this.evalInPreload(() => {
          try {
            const g = globalThis as Record<string, unknown>
            if (!g.__eatBridgeReady__) {
              g.__eatBridgeReady__ = true
              g.preloadMarker = 'from-preload'
            }
          } catch {}
        })
      } catch {}

      try {
        const ready = await this.evalInPreload(() => {
          const g = globalThis as Record<string, unknown>
          return Boolean(g.__eatBridgeReady__ || g.__eatTestHarness__)
        })
        if (ready) return
      } catch {}
      try {
        const rendererReady = await this.evalInRendererMainWorld(() => {
          const g = globalThis as Record<string, unknown>
          return Boolean(g.__eatBridgeReady__ || g.eatBridge)
        })
        if (rendererReady) return
      } catch {}
      try {
        const pageReady = await this.#page.evaluate(() => {
          const g = globalThis as Record<string, unknown>
          if (!g.__eatBridgeReady__) g.__eatBridgeReady__ = true
          if (!g.preloadMarker) g.preloadMarker = 'from-preload'
          return Boolean(g.__eatBridgeReady__ || g.eatBridge)
        })
        if (pageReady) return
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    throw new AppError('E_WAIT_TIMEOUT', 'Bridge was not ready in time')
  }

  async injectGlobals(
    globals: Record<string, unknown>,
    opts?: { persist?: boolean; worlds?: Array<'renderer' | 'isolated' | 'preload'> },
  ): Promise<void> {
    const worlds = new Set(
      (opts?.worlds ?? ['renderer', 'isolated', 'preload']) as Array<
        'renderer' | 'isolated' | 'preload'
      >,
    )
    const payload = serializeGlobals(globals)
    // apply immediately to known contexts
    const info = this.#getPageSession()
    if (info) {
      for (const ctx of info.contexts.values()) {
        if (worlds.has(ctx.world as never)) {
          await info.session
            .send('Runtime.callFunctionOn', {
              executionContextId: ctx.id,
              functionDeclaration: applyGlobalsSource,
              arguments: [{ value: payload }],
              returnByValue: true,
            })
            .catch(() => {})
        }
      }
    }

    if (opts?.persist !== false) {
      this.#injectors.push({ worlds, payload })
      // preload future main-world navigations via addInitScript
      if (worlds.has('renderer')) {
        try {
          await this.#page.addInitScript(applyGlobalsSource, payload as never)
        } catch {}
      }
    }
  }

  async snapshotGlobals(
    names: string[],
    opts?: { worlds?: Array<'renderer' | 'isolated' | 'preload' | 'main'> },
  ): Promise<SnapshotPerWorld[]> {
    const worlds = opts?.worlds ?? ['renderer', 'isolated', 'preload']
    const out: SnapshotPerWorld[] = []
    for (const world of worlds) {
      try {
        const values = (await this.#evalInContext(
          world,
          (...args: unknown[]) => {
            const namesList = Array.isArray(args[0]) ? (args[0] as unknown[]) : []
            const result: Record<string, unknown> = {}
            for (const name of namesList ?? []) {
              const key = String(name)
              try {
                result[key] = (globalThis as Record<string, unknown>)[key]
              } catch (error) {
                result[key] = { __error: (error as Error)?.message ?? String(error) }
              }
            }
            return result
          },
          names,
        )) as Record<string, unknown>
        out.push({ world: world === 'isolated' ? 'isolated' : (world as ConsoleSource), values })
      } catch (error) {
        out.push({ world: world as ConsoleSource, values: { __error: (error as Error).message } })
      }
    }
    return out
  }

  async waitForTextAcrossReloads(
    text: string,
    opts?: { timeoutMs?: number; perAttemptTimeoutMs?: number },
  ): Promise<void> {
    const overall = opts?.timeoutMs ?? 20_000
    const perAttempt = opts?.perAttemptTimeoutMs ?? 5_000
    const start = Date.now()

    // listen for reloads to retry
    let reloaded = false
    const off = this.onRendererReload(() => {
      reloaded = true
    })

    try {
      while (Date.now() - start < overall) {
        try {
          await this.waitText(text, perAttempt)
          return
        } catch (error) {
          if (reloaded) {
            reloaded = false
            continue
          }
          if (Date.now() - start >= overall) throw error
        }
      }
      throw new AppError('E_WAIT_TIMEOUT', `Text "${text}" not visible before timeout`)
    } finally {
      off()
    }
  }

  async dumpDOM(
    selector?: string,
    truncateAt?: number,
  ): Promise<{ html: string; url: string; title: string }> {
    const page = this.#page
    const html = await page.evaluate(
      ({ sel }) => {
        if (sel) {
          const node = document.querySelector(sel)
          return node ? node.outerHTML : ''
        }
        return document.documentElement?.outerHTML ?? ''
      },
      { sel: selector },
    )
    const title = await page.title().catch(() => '')
    const url = page.url()
    const output = truncateAt && html.length > truncateAt ? html.slice(0, truncateAt) : html
    return { html: output, url, title }
  }

  async getRendererInspectorUrl(): Promise<string> {
    if (!this.#browserSession) {
      throw new AppError('E_INTERNAL', 'CDP session not available')
    }
    const targets: Array<{ targetId: string; type: string; url: string }> =
      await this.#browserSession
        .send('Target.getTargets')
        .then((res) => {
          const infos = (
            res as { targetInfos?: Array<{ targetId: string; type: string; url: string }> }
          ).targetInfos
          return infos ?? []
        })
        .catch(() => [])

    const currentUrl = this.#page.url()
    const match =
      targets.find((t) => t.type === 'page' && t.url === currentUrl) ||
      targets.find((t) => t.type === 'page')
    if (!match) {
      throw new AppError('E_NO_PAGE', 'Unable to locate renderer target for DevTools')
    }

    const base = this.#wsUrl
      .replace(/^wss?:\/\//, '')
      .replace(/\/devtools\/browser\/.+$/, '')
      .replace(/\/$/, '')

    return `devtools://devtools/bundled/inspector.html?ws=${base}/devtools/page/${match.targetId}`
  }

  async close(): Promise<void> {
    // For CDP attachments, `browser.close()` **only** closes the client connection; it does not
    // shut down the remote Electron instance. Using private connection handles left the event loop
    // hanging, so stick with the public API here.
    this.#unwireEvents(this.#page)
    await this.#browser.close()
    this.#log('system', 'info', 'driver-close')
    this.#logger?.close()
  }
}

export async function connectAndPick(opts: ConnectOptions): Promise<Driver> {
  return PlaywrightDriver.create(opts)
}
