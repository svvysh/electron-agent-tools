import assert from 'node:assert'
import { execFile } from 'node:child_process'
import { access, mkdtemp, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..', '..')
const electronBin = path.join(root, 'node_modules/.bin/electron')

let built = false
const buildOnce = async () => {
  if (built) return
  await execFileAsync('pnpm', ['build'], { cwd: root, env: { ...process.env, NODE_ENV: 'test' } })
  built = true
}

const run = async (cmd, args, opts = {}) =>
  execFileAsync(cmd, args, {
    cwd: root,
    env: { ...process.env, NODE_ENV: 'test' },
    ...opts,
  })

const findLatestArtifact = async (filename, dir = '.e2e-artifacts') => {
  const artifactRoot = path.join(root, dir)
  const entries = await readdir(artifactRoot).catch(() => [])
  let latestPath = null
  let latestMtime = 0
  for (const entry of entries) {
    const candidate = path.join(artifactRoot, entry, filename)
    try {
      const st = await stat(candidate)
      if (st.isFile() && st.mtimeMs > latestMtime) {
        latestMtime = st.mtimeMs
        latestPath = candidate
      }
    } catch {
      // ignore
    }
  }
  return latestPath
}

const runBrowserTool = (sub, payload) =>
  run('node', [path.join(root, 'dist/cli/browser-tools.js'), sub, JSON.stringify(payload)]).then(
    (res) => JSON.parse(res.stdout),
  )

const loadLib = () => import(pathToFileURL(path.join(root, 'dist/index.js')).href)

test(
  'browser-tools subcommands, artifacts, and window helpers',
  { concurrency: false },
  async () => {
    await buildOnce()
    const { launchElectron } = await loadLib()
    const launch = await launchElectron({
      command: electronBin,
      args: [path.join(root, 'fixtures/main.js')],
      artifactPrefix: 'cli-spec',
    })

    const wsUrl = launch.wsUrl

    // wait-text and click
    await runBrowserTool('wait-text', { wsUrl, text: 'click button', timeoutMs: 15000 })
    await runBrowserTool('click', { wsUrl, testid: 'click-button' })
    await runBrowserTool('wait-text', { wsUrl, text: 'Select a folder', timeoutMs: 15000 })

    // type + press enter on input
    await runBrowserTool('type', {
      wsUrl,
      testid: 'name-input',
      value: 'hello',
      clearFirst: true,
    })
    await runBrowserTool('press', { wsUrl, key: 'Enter', testid: 'name-input' })
    await runBrowserTool('wait-text', { wsUrl, text: 'pressed enter', timeoutMs: 10000 })

    // hover updates text
    await runBrowserTool('hover', { wsUrl, testid: 'hover-target' })
    await runBrowserTool('wait-text', { wsUrl, text: 'hovered', timeoutMs: 10000 })

    // list-windows
    const windows = await runBrowserTool('list-windows', { wsUrl })
    assert.ok(windows.ok, `list-windows failed: ${JSON.stringify(windows)}`)
    assert.ok(windows.data.pages.length >= 1)

    // list-selectors
    const selectors = await runBrowserTool('list-selectors', { wsUrl })
    assert.ok(selectors.data.testIds.includes('click-button'))

    // dom-snapshot (also writes artifact)
    const domSnapshot = await runBrowserTool('dom-snapshot', { wsUrl, truncateAt: 5000 })
    assert.strictEqual(domSnapshot.ok, true)

    // screenshot artifact with custom dir/prefix
    await runBrowserTool('screenshot', {
      wsUrl,
      artifactDir: '.custom-artifacts',
      artifactPrefix: 'cli-spec',
      fullPage: true,
    })
    await access(path.join(root, '.custom-artifacts/cli-spec/page.png'))

    // scroll into view sets scroll-status
    await runBrowserTool('scroll-into-view', { wsUrl, testid: 'far-target' })
    const scrollStatus = await runBrowserTool('get-dom', {
      wsUrl,
      css: '#scroll-status',
      as: 'textContent',
    })
    assert.strictEqual(scrollStatus.data.value.trim(), 'scrolled')

    // upload
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'e2e-'))
    const uploadFile = path.join(tmpDir, 'upload.txt')
    await writeFile(uploadFile, 'hello')
    await runBrowserTool('upload', { wsUrl, testid: 'file-input', filePath: uploadFile })
    const uploadEcho = await runBrowserTool('get-dom', {
      wsUrl,
      testid: 'file-output',
      as: 'textContent',
    })
    assert.strictEqual(uploadEcho.data.value.trim(), 'upload.txt')

    // open new window and switch to it
    await runBrowserTool('click', { wsUrl, testid: 'open-window' })
    const waited = await runBrowserTool('wait-for-window', {
      wsUrl,
      pick: { titleContains: 'Second' },
      timeoutMs: 15000,
    })
    assert.ok(waited.data.url.includes('second.html'))

    const switched = await runBrowserTool('switch-window', {
      wsUrl,
      pick: { titleContains: 'Second' },
    })
    assert.ok(switched.data.title.includes('Second'))

    // console-harvest (fixture logs on load)
    const consoleData = await runBrowserTool('console-harvest', { wsUrl })
    assert.strictEqual(consoleData.ok, true)

    // network-harvest (fixture may be empty but should succeed)
    const netData = await runBrowserTool('network-harvest', { wsUrl })
    assert.strictEqual(netData.ok, true)

    // ensure process exits via launch helper quit
    await launch.quit()

    // confirm artifacts exist
    const domFile = await findLatestArtifact('dom-snapshot.html')
    assert.ok(domFile, 'dom-snapshot artifact present')

    const consoleFile = await findLatestArtifact('console-harvest.json')
    assert.ok(consoleFile, 'console-harvest artifact present')

    const networkFile = await findLatestArtifact('network-harvest.json')
    assert.ok(networkFile, 'network-harvest artifact present')

    const lastRun = path.join(root, '.e2e-artifacts/last-run')
    const lastRunTarget = await realpath(lastRun)
    const resolvedLatestDir = await realpath(path.dirname(networkFile))
    assert.strictEqual(lastRunTarget, resolvedLatestDir, 'last-run points to latest artifacts')
    await access(path.join(lastRunTarget, 'network-harvest.json'))
  },
)

test('launch-electron CLI start/quit', { concurrency: false }, async () => {
  await buildOnce()

  const payload = {
    command: electronBin,
    args: [path.join(root, 'fixtures/main.js')],
    artifactPrefix: 'cli-launch',
  }

  const start = await run('node', [
    path.join(root, 'dist/cli/launch-electron.js'),
    'start',
    JSON.stringify(payload),
  ])
  const startJson = JSON.parse(start.stdout)
  assert.strictEqual(startJson.ok, true)
  assert.ok(startJson.data.wsUrl)
  assert.ok(startJson.data.pid)

  const quit = await run('node', [
    path.join(root, 'dist/cli/launch-electron.js'),
    'quit',
    JSON.stringify({
      launchFile: startJson.data.launchFile,
      pid: startJson.data.electronPid ?? startJson.data.pid,
    }),
  ])
  const quitJson = JSON.parse(quit.stdout)
  assert.strictEqual(quitJson.ok, true)
})
