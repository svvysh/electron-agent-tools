import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  type Browser,
  type ConsoleMessage,
  chromium,
  type Locator,
  type Page,
  type Request,
  type Response,
} from 'playwright'
import type { AppErrorCode } from './error-codes.js'
import type { ConnectOptions, ConsoleEvent, Driver, NetworkHarvest, Selector } from './types.js'

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
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: Bug in biome
  #consoleEvents: ConsoleEvent[] = []
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: Bug in biome
  #network: NetworkHarvest = { failed: [], errorResponses: [] }
  #listeners = {
    console: (event: ConsoleMessage) => {
      this.#consoleEvents.push({
        type: event.type(),
        text: event.text(),
        ts: Date.now(),
      })
    },
    pageerror: (error: Error) => {
      this.#consoleEvents.push({
        type: 'error',
        text: error.message,
        ts: Date.now(),
      })
    },
    requestfailed: (request: Request) => {
      const url = request.url()
      if (url) this.#network.failed.push(url)
    },
    response: (response: Response) => {
      if (response.status() >= 400) {
        this.#network.errorResponses.push({
          url: response.url(),
          status: response.status(),
        })
      }
    },
  }

  constructor(browser: Browser, page: Page) {
    this.#browser = browser
    this.#page = page
    this.#wireEvents(page)
  }

  #wireEvents(page: Page) {
    page.on('console', this.#listeners.console)
    page.on('pageerror', this.#listeners.pageerror)
    page.on('requestfailed', this.#listeners.requestfailed)
    page.on('response', this.#listeners.response)
  }

  #unwireEvents(page?: Page) {
    if (!page) return
    page.off('console', this.#listeners.console)
    page.off('pageerror', this.#listeners.pageerror)
    page.off('requestfailed', this.#listeners.requestfailed)
    page.off('response', this.#listeners.response)
  }

  #setPage(page: Page) {
    this.#unwireEvents(this.#page)
    this.#page = page
    this.#wireEvents(page)
  }

  /** Expose underlying Playwright page (primarily for CLI plumbing). */
  get page(): Page {
    return this.#page
  }

  static async create(opts: ConnectOptions): Promise<PlaywrightDriver> {
    const browser = await chromium.connectOverCDP(opts.wsUrl)
    const contexts = browser.contexts()
    const pages = contexts.flatMap((ctx) => ctx.pages())

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

    return new PlaywrightDriver(browser, best.page)
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

    this.#setPage(best.page)
    return { url: best.url, title: best.title }
  }

  async flushConsole(): Promise<ConsoleEvent[]> {
    const out = [...this.#consoleEvents]
    this.#consoleEvents.length = 0
    return out
  }

  async flushNetwork(): Promise<NetworkHarvest> {
    const out: NetworkHarvest = {
      failed: [...this.#network.failed],
      errorResponses: [...this.#network.errorResponses],
    }
    this.#network.failed = []
    this.#network.errorResponses = []
    return out
  }

  async close(): Promise<void> {
    // For CDP attachments, `browser.close()` **only** closes the client connection; it does not
    // shut down the remote Electron instance. Using private connection handles left the event loop
    // hanging, so stick with the public API here.
    this.#unwireEvents(this.#page)
    await this.#browser.close()
  }
}

export async function connectAndPick(opts: ConnectOptions): Promise<Driver> {
  return PlaywrightDriver.create(opts)
}
