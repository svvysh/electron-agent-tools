import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow } from 'electron'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const headless = process.env.E2E_HEADLESS === '1'

if (process.env.E2E_CDP_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.E2E_CDP_PORT)
}

if (headless) {
  app.commandLine.appendSwitch('headless')
  app.commandLine.appendSwitch('disable-gpu')
}

const createWindow = () => {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      nativeWindowOpen: true,
    },
    show: !headless,
  })

  win.loadFile(path.join(__dirname, 'index.html'))
}

app.whenReady().then(() => {
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
