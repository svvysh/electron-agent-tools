// Guards against EPIPE when the read end of stdout/stderr is closed (common in headless Playwright runs).
// Idempotent so multiple CLI entrypoints can call it safely.
let pipedGuarded = false

export const guardBrokenPipes = (): void => {
  if (pipedGuarded) return
  pipedGuarded = true

  const swallow = (err: NodeJS.ErrnoException) => {
    if (err?.code === 'EPIPE') return
    throw err
  }

  process.stdout.on('error', swallow)
  process.stderr.on('error', swallow)
  process.on('uncaughtException', swallow)
}

// Write defensively: skip if the stream is already closed/destroyed and swallow EPIPE.
type WritableLike = NodeJS.WritableStream & {
  destroyed?: boolean
  writableEnded?: boolean
  writable?: boolean
}

export const safeWrite = (stream: WritableLike, data: string): void => {
  if (stream.destroyed || stream.writableEnded === true || stream.writable === false) return
  try {
    stream.write(data)
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === 'EPIPE') return
    throw err
  }
}
