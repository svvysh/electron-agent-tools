import { execFile, spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import * as path from 'node:path'

import { prepareArtifactRun } from './artifacts.js'
import type { LaunchErrorCode } from './error-codes.js'
import { getWsUrl } from './get-ws-url.js'
import type { LaunchOptions, LaunchResult } from './types.js'

export class LaunchError extends Error {
  code: LaunchErrorCode
  details?: Record<string, unknown> | undefined

  constructor(code: LaunchErrorCode, message: string, details?: Record<string, unknown>) {
    super(message)
    this.code = code
    this.details = details
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type PsRow = { pid: number; ppid: number; cmd: string; depth: number }

const listChildren = async (pid: number): Promise<PsRow[]> =>
  new Promise((resolve) => {
    execFile('ps', ['-eo', 'pid=', '-o', 'ppid=', '-o', 'command='], (err, stdout) => {
      if (err || !stdout) return resolve([])
      const rows = stdout
        .trim()
        .split(/\n+/)
        .map((line) => {
          const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)
          if (!match) return null
          const pidStr = match[1] ?? '0'
          const ppidStr = match[2] ?? '0'
          const cmd = match[3] ?? ''
          return {
            pid: Number.parseInt(pidStr, 10),
            ppid: Number.parseInt(ppidStr, 10),
            cmd,
          }
        })
        .filter((row): row is { pid: number; ppid: number; cmd: string } => Boolean(row))
        .filter((row) => Number.isFinite(row.pid) && Number.isFinite(row.ppid))

      const children: PsRow[] = []
      const visit = (parent: number, depth: number) => {
        rows
          .filter((row) => row.ppid === parent)
          .forEach((row) => {
            if (!children.some((c) => c.pid === row.pid)) {
              children.push({ ...row, depth })
              visit(row.pid, depth + 1)
            }
          })
      }
      visit(pid, 1)
      resolve(children)
    })
  })

const findPort = async (preferred?: number): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', (err) => {
      server.close()
      if ((err as { code?: string }).code === 'EADDRINUSE') {
        findPort().then(resolve).catch(reject)
      } else {
        reject(err)
      }
    })
    server.listen(preferred ?? 0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => {
        if (address && typeof address === 'object') {
          resolve(address.port)
        } else {
          resolve(preferred ?? 0)
        }
      })
    })
  })

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export const terminateTree = async (
  pid: number,
  {
    timeoutMs = 3000,
    logger,
  }: { timeoutMs?: number; logger?: (msg: string, meta?: unknown) => void } = {},
): Promise<boolean> => {
  if (process.platform === 'win32') {
    const taskkill = async (force: boolean): Promise<boolean> =>
      new Promise((resolve) => {
        const args = ['/PID', String(pid), '/T']
        if (force) args.unshift('/F')
        execFile('taskkill', args, (err) => resolve(!err))
      })

    const phases: { force: boolean; waitMs: number }[] = [
      { force: false, waitMs: 400 },
      { force: true, waitMs: 400 },
    ]

    for (const { force, waitMs } of phases) {
      await taskkill(force)
      await wait(waitMs)
      if (!isAlive(pid)) return true
      if (logger) logger('terminateTree still alive', { pid, force })
    }

    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (!isAlive(pid)) return true
      await wait(100)
    }

    if (logger) logger('terminateTree timeout', { pid })
    return !isAlive(pid)
  }

  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGKILL']
  for (const signal of signals) {
    try {
      process.kill(-pid, signal)
    } catch {}
    try {
      process.kill(pid, signal)
    } catch {}
    await wait(signal === 'SIGKILL' ? 250 : 400)
    if (!isAlive(pid)) return true
    if (logger) logger('terminateTree still alive', { pid, signal })
  }

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true
    await wait(100)
  }

  // Fallback: try pkill children then final KILL
  try {
    await new Promise((resolve) =>
      execFile('pkill', ['-TERM', '-P', String(pid)], () => resolve(undefined)),
    )
    await wait(200)
    await new Promise((resolve) =>
      execFile('pkill', ['-KILL', '-P', String(pid)], () => resolve(undefined)),
    )
    await wait(200)
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  } catch {}

  if (!isAlive(pid)) return true
  if (logger) logger('terminateTree timeout', { pid })
  return false
}

export const launchElectron = async (opts: LaunchOptions): Promise<LaunchResult> => {
  const debug = Boolean(process.env.DEBUG_LAUNCH)
  const artifactRun = await prepareArtifactRun({
    artifactDir: opts.artifactDir,
    artifactPrefix: opts.artifactPrefix,
  })

  const cdpPort = opts.cdpPort ?? (await findPort())

  const stdoutPath = path.join(artifactRun.dir, 'electron.stdout.log')
  const stderrPath = path.join(artifactRun.dir, 'electron.stderr.log')
  const stdoutFd = openSync(stdoutPath, 'a')
  const stderrFd = openSync(stderrPath, 'a')

  let logsClosed = false
  const closeLogs = () => {
    if (logsClosed) return
    logsClosed = true
    try {
      closeSync(stdoutFd)
    } catch {}
    try {
      closeSync(stderrFd)
    } catch {}
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    E2E: '1',
    NODE_ENV: 'test',
    ELECTRON_ENABLE_LOGGING: '1',
    E2E_CDP_PORT: String(cdpPort),
    ...opts.env,
  }
  if (opts.headless) env.E2E_HEADLESS = '1'

  const child = spawn(opts.command, opts.args ?? [], {
    cwd: opts.cwd ?? process.cwd(),
    env,
    stdio: ['ignore', stdoutFd, stderrFd],
    detached: true,
  })

  child.unref()

  if (debug) {
    process.stderr.write(`DEBUG_LAUNCH start pid=${child.pid} cdpPort=${cdpPort}\n`)
  }

  let cdpReady = false
  let removeEarlyListeners: (() => void) | undefined

  const earlyFailurePromise = new Promise<never>((_, reject) => {
    const onError = (err: Error) => {
      if (cdpReady) return
      removeEarlyListeners?.()
      reject(
        new LaunchError('E_SPAWN', 'Failed to spawn Electron', {
          error: err,
          stderrPath,
        }),
      )
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (cdpReady) return
      removeEarlyListeners?.()
      reject(
        new LaunchError('E_EXIT_EARLY', 'Electron exited before CDP became ready', {
          code,
          signal,
          stderrPath,
        }),
      )
    }
    removeEarlyListeners = () => {
      child.off('error', onError)
      child.off('exit', onExit)
      child.off('close', onExit)
    }
    child.on('error', onError)
    child.on('exit', onExit)
    child.on('close', onExit)
  })

  const resolveElectronPid = async (rootPid: number): Promise<number> => {
    const descendants = await listChildren(rootPid)
    if (!descendants.length) return rootPid

    const launchedBasename = path.basename(opts.command ?? '').toLowerCase()
    const isLikelyElectron = (cmd: string): { score: number; matched: boolean } => {
      const lower = cmd.toLowerCase()
      let score = 0

      if (launchedBasename && lower.includes(launchedBasename)) {
        score += 5
      }

      if (/[\\/](electron|electron\.app[\\/].+?macos[\\/](electron|electron helper))/i.test(cmd)) {
        score += 4
      }

      if (/\belectron(?: helper)?(?: \([^)]+\))?\b/i.test(cmd)) {
        score += 3
      }

      if (/\bchrome(?:ium)? helper\b/i.test(cmd)) {
        score += 1
      }

      return { score, matched: score > 0 }
    }

    const ranked = descendants
      .map((row) => {
        const result = isLikelyElectron(row.cmd)
        return { ...row, ...result }
      })
      .filter((row) => row.matched)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score
        if (a.depth !== b.depth) return a.depth - b.depth
        return a.pid - b.pid
      })

    return ranked[0]?.pid ?? rootPid
  }

  let electronPidResolved: number | undefined

  const quit = async () => {
    if (child.pid) {
      const logFn = debug
        ? (msg: string, meta?: unknown) => {
            process.stderr.write(`DEBUG_LAUNCH ${msg} ${JSON.stringify(meta)}\n`)
          }
        : undefined

      const okRoot = await terminateTree(child.pid, logFn ? { logger: logFn } : undefined)
      if (!okRoot)
        throw new LaunchError('E_SPAWN', 'Failed to terminate Electron process', { pid: child.pid })
      if (electronPidResolved && electronPidResolved !== child.pid) {
        await terminateTree(electronPidResolved, logFn ? { logger: logFn } : undefined)
      }

      // Final sweep: kill any remaining descendants of the root (renderer/GPU helpers).
      const leftover = await listChildren(child.pid)
      if (leftover.length && logFn) logFn('leftover descendants', leftover)
      for (const proc of leftover) {
        try {
          process.kill(proc.pid, 'SIGKILL')
        } catch {}
      }
    }
    closeLogs()
  }

  try {
    const wsUrl = await Promise.race([
      getWsUrl({ port: cdpPort, timeoutMs: opts.timeoutMs ?? 40_000 }),
      earlyFailurePromise,
    ])
    cdpReady = true
    removeEarlyListeners?.()

    await wait(300)
    electronPidResolved = child.pid ? await resolveElectronPid(child.pid) : undefined
    const launchFile = path.join(artifactRun.dir, 'launch.json')
    await writeFile(
      launchFile,
      JSON.stringify(
        {
          wsUrl,
          pid: child.pid,
          electronPid: electronPidResolved,
          cdpPort,
          artifactDir: artifactRun.dir,
        },
        null,
        2,
      ),
      'utf-8',
    )

    return {
      wsUrl,
      pid: child.pid ?? -1,
      electronPid: electronPidResolved,
      cdpPort,
      artifactDir: artifactRun.dir,
      launchFile,
      quit,
    }
  } catch (error) {
    await quit()
    if (debug) {
      process.stderr.write(
        `DEBUG_LAUNCH error pid=${child.pid ?? -1} ${(error as Error).message}\n`,
      )
    }
    if (error instanceof LaunchError) throw error
    throw new LaunchError('E_CDP_TIMEOUT', 'Timed out waiting for CDP', { error })
  } finally {
    closeLogs()
  }
}
