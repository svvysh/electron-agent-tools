import { setTimeout as delay } from 'node:timers/promises'

export type WsOptions = { port: number; timeoutMs?: number }

/**
 * Polls the Chrome DevTools /json/version endpoint and returns the webSocketDebuggerUrl.
 * Leaves process management to the caller.
 */
export async function getWsUrl({ port, timeoutMs = 30_000 }: WsOptions): Promise<string> {
  const deadline = Date.now() + timeoutMs
  const url = `http://127.0.0.1:${port}/json/version`
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) {
        const json = (await res.json()) as { webSocketDebuggerUrl?: string }
        if (json.webSocketDebuggerUrl) return json.webSocketDebuggerUrl
      }
    } catch (error) {
      lastError = error
    }
    await delay(400)
  }
  throw Object.assign(new Error(`Timed out waiting for CDP on port ${port}`), {
    details: { port, timeoutMs, lastError },
  })
}
