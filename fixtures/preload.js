// preload runs in a CommonJS context under Electron; use require instead of ESM import
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { contextBridge, ipcRenderer } = require('electron')
globalThis.ipcRenderer = ipcRenderer

// Signal readiness for waitForBridge and snapshot tests
globalThis.__eatBridgeReady__ = true
try {
  if (typeof window !== 'undefined') {
    window.__eatBridgeReady__ = true
    window.preloadMarker = 'from-preload'
  }
} catch {}
globalThis.preloadMarker = 'from-preload'

// Simple IPC helper for tracing tests
globalThis.eatPing = async (message = 'ping') => ipcRenderer.invoke('eat-ping', message)

// Expose a tiny bridge to renderer main world
contextBridge.exposeInMainWorld('eatBridge', {
  ping: (message = 'ping') => ipcRenderer.invoke('eat-ping', message),
  setValue: (key, value) => {
    try {
      globalThis[key] = value
    } catch {}
    return true
  },
})

console.log('preload-ready')
