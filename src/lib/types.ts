import type { Page } from 'playwright'

export type ConnectOptions = {
  wsUrl: string
  pick?: { titleContains?: string; urlIncludes?: string }
}

export type Selector = {
  testid?: string
  role?: { role: string; name?: string }
  text?: string
  css?: string
  nth?: number
  timeoutMs?: number
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
  launchFile?: string
  quit: () => Promise<void>
}

export type ConsoleEvent = { type: string; text: string; ts: number }

export type NetworkHarvest = {
  failed: string[]
  errorResponses: { url: string; status: number }[]
}

export interface Driver {
  /** Access to the underlying Playwright page (optional). */
  page?: Page
  click(sel: Selector): Promise<void>
  type(sel: Selector & { value: string; clearFirst?: boolean }): Promise<void>
  press(key: string, sel?: Selector): Promise<void>
  hover(sel: Selector): Promise<void>
  scrollIntoView(sel: Selector): Promise<void>
  upload(sel: Selector, filePath: string): Promise<void>
  waitText(text: string, timeoutMs?: number): Promise<void>
  screenshot(path: string, fullPage?: boolean): Promise<void>
  dumpOuterHTML(truncateAt?: number): Promise<string>
  listSelectors(max?: number): Promise<{
    testIds: string[]
    roles: { role: string; name: string | null; selector: string }[]
    texts: { text: string; selector: string }[]
  }>
  waitForWindow(
    timeoutMs?: number,
    pick?: ConnectOptions['pick'],
  ): Promise<{ url: string; title: string }>
  switchWindow(pick: ConnectOptions['pick']): Promise<{ url: string; title: string }>
  flushConsole(): Promise<ConsoleEvent[]>
  flushNetwork(): Promise<NetworkHarvest>
  close(): Promise<void>
}
