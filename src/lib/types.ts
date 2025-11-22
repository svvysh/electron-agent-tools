import type { Page } from 'playwright'

export type ConnectOptions = {
  wsUrl: string
  pick?: { titleContains?: string | undefined; urlIncludes?: string | undefined } | undefined
}

export type Selector = {
  testid?: string | undefined
  role?: { role: string; name?: string | undefined } | undefined
  text?: string | undefined
  css?: string | undefined
  nth?: number | undefined
  timeoutMs?: number | undefined
}

export type ArtifactOptions = {
  artifactDir?: string | undefined
  artifactPrefix?: string | undefined
}

export type LaunchOptions = {
  /** Command to start Electron (e.g., node_modules/.bin/electron). */
  command: string
  /** Arguments passed to the command (e.g., path to main file). */
  args?: string[] | undefined
  /** Working directory for the spawned process. */
  cwd?: string | undefined
  /** Environment variables merged with process.env. */
  env?: NodeJS.ProcessEnv | undefined
  /** Launch Electron without showing a window (passed via E2E_HEADLESS=1). */
  headless?: boolean | undefined
  /** Explicit CDP port; defaults to an available random port. */
  cdpPort?: number | undefined
  /** Timeout for CDP readiness. */
  timeoutMs?: number | undefined
} & ArtifactOptions

export type LaunchResult = {
  wsUrl: string
  cdpPort: number
  pid: number
  electronPid?: number | undefined
  artifactDir: string
  /** Persisted launch metadata (optional helper for CLIs). */
  launchFile?: string | undefined
  quit: () => Promise<void>
}

export type ConsoleEvent = { type: string; text: string; ts: number }

export type ConsoleSource = 'main' | 'preload' | 'renderer' | 'isolated' | 'worker' | 'unknown'

export type ConsoleEntry = ConsoleEvent & {
  source: ConsoleSource
  args?: unknown[]
  location?: { url?: string; lineNumber?: number; columnNumber?: number }
}

export type FlushConsoleOptions = { sources?: ConsoleSource[]; sinceTs?: number }

export type IpcTraceDirection = 'renderer->main' | 'main->renderer'

export type IpcTraceEntry = {
  direction: IpcTraceDirection
  kind: 'send' | 'invoke' | 'event'
  channel: string
  payload: unknown
  durationMs?: number
  error?: string
  ts: number
}

export type SnapshotPerWorld = {
  world: ConsoleSource
  values: Record<string, unknown>
}

export type NetworkHarvest = {
  failed: string[]
  errorResponses: { url: string; status: number }[]
}

export interface Driver {
  /** Access to the underlying Playwright page (optional). */
  page?: Page | undefined
  click(sel: Selector): Promise<void>
  type(sel: Selector & { value: string; clearFirst?: boolean | undefined }): Promise<void>
  press(key: string, sel?: Selector | undefined): Promise<void>
  hover(sel: Selector): Promise<void>
  scrollIntoView(sel: Selector): Promise<void>
  upload(sel: Selector, filePath: string): Promise<void>
  waitText(text: string, timeoutMs?: number | undefined): Promise<void>
  screenshot(path: string, fullPage?: boolean | undefined): Promise<void>
  dumpOuterHTML(truncateAt?: number | undefined): Promise<string>
  listSelectors(max?: number | undefined): Promise<{
    testIds: string[]
    roles: { role: string; name: string | null; selector: string }[]
    texts: { text: string; selector: string }[]
  }>
  waitForWindow(
    timeoutMs?: number | undefined,
    pick?: ConnectOptions['pick'],
  ): Promise<{ url: string; title: string }>
  switchWindow(pick: ConnectOptions['pick']): Promise<{ url: string; title: string }>
  flushConsole(): Promise<ConsoleEvent[]>
  flushConsole(opts?: FlushConsoleOptions): Promise<ConsoleEntry[]>
  flushNetwork(): Promise<NetworkHarvest>
  evalInRendererMainWorld<T = unknown>(fn: (...args: unknown[]) => T, arg?: unknown): Promise<T>
  evalInIsolatedWorld<T = unknown>(fn: (...args: unknown[]) => T, arg?: unknown): Promise<T>
  evalInPreload<T = unknown>(fn: (...args: unknown[]) => T, arg?: unknown): Promise<T>
  onRendererReload(cb: () => void): () => void
  onPreloadReady(cb: () => void): () => void
  waitForBridge(timeoutMs?: number): Promise<void>
  injectGlobals(
    globals: Record<string, unknown>,
    opts?: { persist?: boolean; worlds?: Array<'renderer' | 'isolated' | 'preload'> },
  ): Promise<void>
  enableIpcTracing(enabled?: boolean): Promise<void>
  flushIpc(): Promise<IpcTraceEntry[]>
  snapshotGlobals(
    names: string[],
    opts?: { worlds?: Array<'renderer' | 'isolated' | 'preload' | 'main'> },
  ): Promise<SnapshotPerWorld[]>
  waitForTextAcrossReloads(
    text: string,
    opts?: { timeoutMs?: number; perAttemptTimeoutMs?: number },
  ): Promise<void>
  dumpDOM(
    selector?: string,
    truncateAt?: number,
  ): Promise<{ html: string; url: string; title: string }>
  getRendererInspectorUrl(): Promise<string>
  close(): Promise<void>
}
