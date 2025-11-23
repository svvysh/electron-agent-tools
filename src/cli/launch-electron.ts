import { readFile } from 'node:fs/promises'
import { guardBrokenPipes, safeWrite } from './safe-stdio.js'
import { launchElectron, terminateTree } from '../lib/launch-electron.js'
import type { LaunchOptions } from '../lib/types.js'

guardBrokenPipes()

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
  safeWrite(process.stdout, `${JSON.stringify(payload)}\n`)
}

const fail = (code: string, message: string, details?: Record<string, unknown>) => {
  process.exitCode = 1
  printJson({ ok: false, error: { message, code, details } })
}

const parseArg = (): ParseResult => {
  const sub = process.argv[2] ?? 'start'
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

const readLaunchFile = async (
  maybePath?: unknown,
): Promise<{ pid?: number; electronPid?: number } | null> => {
  const launchFile = typeof maybePath === 'string' ? maybePath : undefined
  if (!launchFile) return null
  try {
    const raw = await readFile(launchFile, 'utf-8')
    return JSON.parse(raw) as { pid?: number; electronPid?: number }
  } catch {
    return null
  }
}

const quitPid = async (pid: number) => terminateTree(pid, { timeoutMs: 4000, logger: debugLog })

const debugLog = (...args: unknown[]) => {
  if (process.env.DEBUG_LAUNCH) {
    console.error('[launch-electron]', ...args)
  }
}

const run = async () => {
  const parsed = parseArg()
  if (!parsed.ok) {
    printJson(parsed)
    process.exitCode = 1
    return
  }
  const { sub, payload } = parsed

  try {
    switch (sub) {
      case 'start':
      case 'launch': {
        const command = typeof payload.command === 'string' ? payload.command : ''
        if (!command) throw new Error('command required')

        const args = Array.isArray(payload.args)
          ? (payload.args as string[])
          : typeof payload.args === 'string'
            ? (payload.args as string).split(' ').filter(Boolean)
            : []

        const opts = {
          command,
          args,
          cwd: typeof payload.cwd === 'string' ? payload.cwd : undefined,
          env:
            typeof payload.env === 'object' && payload.env
              ? (payload.env as Record<string, string>)
              : undefined,
          headless: payload.headless === true,
          cdpPort: typeof payload.cdpPort === 'number' ? payload.cdpPort : undefined,
          timeoutMs: typeof payload.timeoutMs === 'number' ? payload.timeoutMs : undefined,
          artifactDir: typeof payload.artifactDir === 'string' ? payload.artifactDir : undefined,
          artifactPrefix:
            typeof payload.artifactPrefix === 'string' ? payload.artifactPrefix : undefined,
        } as const satisfies LaunchOptions

        const result = await launchElectron(opts)
        debugLog('started', { pid: result.pid, wsUrl: result.wsUrl })
        printJson({
          ok: true,
          data: {
            wsUrl: result.wsUrl,
            pid: result.pid,
            electronPid: result.electronPid ?? null,
            cdpPort: result.cdpPort,
            artifactDir: result.artifactDir,
            runLogPath: result.runLogPath,
            launchFile: result.launchFile,
            quitHint: { pid: result.electronPid ?? result.pid, launchFile: result.launchFile },
          },
        })
        return
      }
      case 'quit': {
        const launch = await readLaunchFile(payload.launchFile)
        const payloadPid = typeof payload.pid === 'number' ? (payload.pid as number) : null
        const rootPid = launch?.pid ?? payloadPid
        if (!rootPid) throw new Error('pid or launchFile required')

        const electronPid =
          typeof launch?.electronPid === 'number'
            ? launch.electronPid
            : typeof payload.electronPid === 'number'
              ? (payload.electronPid as number)
              : undefined

        const rootOk = await quitPid(rootPid)
        const electronOk =
          !electronPid || electronPid === rootPid ? true : await quitPid(electronPid)

        debugLog('quit', { rootPid, electronPid, rootOk, electronOk })
        if (!rootOk || !electronOk) {
          throw Object.assign(new Error('Failed to quit process'), { code: 'E_SPAWN' })
        }
        printJson({
          ok: true,
          data: { quit: true, pid: rootPid, electronPid: electronPid ?? null },
        })
        return
      }
      default:
        fail('E_INTERNAL', `Unknown subcommand: ${sub}`)
    }
  } catch (error) {
    const code = (error as { code?: string }).code ?? 'E_INTERNAL'
    debugLog('error', { code, message: (error as Error).message, stack: (error as Error).stack })
    fail(code, 'Unexpected error', { error })
  }
}

await run()
