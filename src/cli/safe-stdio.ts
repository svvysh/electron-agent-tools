// Guards against EPIPE when the read end of stdout/stderr is closed (common in headless Playwright runs).
export const guardBrokenPipes = (): void => {
  const swallow = (stream: NodeJS.WritableStream) => {
    stream.on('error', (err: NodeJS.ErrnoException) => {
      if (err?.code === 'EPIPE') return
      throw err
    })
  }
  swallow(process.stdout)
  swallow(process.stderr)
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
