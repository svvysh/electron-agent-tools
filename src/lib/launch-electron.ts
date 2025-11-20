import { execFile, spawn } from 'node:child_process'
import { openSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import * as path from 'node:path'

import { prepareArtifactRun } from './artifacts.js'
import { getWsUrl } from './get-ws-url.js'
import type { LaunchOptions, LaunchResult } from './types.js'

class LaunchError extends Error {
  code: string
  details?: Record<string, unknown> | undefined

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message)
    this.code = code
    this.details = details
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type PsRow = { pid: number; ppid: number; cmd: string }

const listChildren = async (pid: number): Promise<PsRow[]> =>
  new Promise((resolve) => {
    execFile('ps', ['-eo', 'pid=', '-o', 'ppid=', '-o', 'comm='], (err, stdout) => {
      if (err || !stdout) return resolve([])
      const rows = stdout
        .trim()
        .split(/\n+/)
        .map((line) => line.trim().split(/\s+/, 3))
        .map(([pidStr = '0', ppidStr = '0', ...rest]) => ({
          pid: Number.parseInt(pidStr, 10),
          ppid: Number.parseInt(ppidStr, 10),
          cmd: rest.join(' '),
        }))
        .filter((row) => Number.isFinite(row.pid) && Number.isFinite(row.ppid)) as PsRow[]

      const children: PsRow[] = []
      const visit = (parent: number) => {
        rows
          .filter((row) => row.ppid === parent)
          .forEach((row) => {
            if (!children.some((c) => c.pid === row.pid)) {
              children.push(row)
              visit(row.pid)
            }
          })
      }
      visit(pid)
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

  let spawnError: Error | null = null
  child.once('error', (err) => {
    spawnError = err as Error
  })

  const resolveElectronPid = async (rootPid: number): Promise<number> => {
    const descendants = await listChildren(rootPid)
    const electronChild = descendants
      .filter((row) => /Electron/i.test(row.cmd))
      .sort((a, b) => b.pid - a.pid)[0]
    return electronChild ? electronChild.pid : rootPid
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
    // best-effort stream cleanup
    // nothing else to close; child stdio is fd-based
  }

  try {
    if (spawnError) {
      throw new LaunchError('E_SPAWN', 'Failed to spawn Electron', { error: spawnError })
    }

    const wsUrl = await getWsUrl({ port: cdpPort, timeoutMs: opts.timeoutMs ?? 40_000 })
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
  }
}
