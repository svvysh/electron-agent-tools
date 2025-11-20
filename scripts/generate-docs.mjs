#!/usr/bin/env node

import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

const here = path.dirname(new URL(import.meta.url).pathname)
const root = path.resolve(here, '..')

const readUtf8 = (p) => readFile(p, 'utf8')
const toPosix = (p) => p.split(path.sep).join('/')

const extractCaption = (readme) => {
  const lines = readme.split(/\r?\n/)
  let i = 0
  while (i < lines.length && lines[i].trim().startsWith('#')) i += 1
  while (i < lines.length && lines[i].trim() === '') i += 1
  const out = []
  for (; i < lines.length; i += 1) {
    if (lines[i].trim() === '') break
    out.push(lines[i])
  }
  return out.join('\n').trim()
}

const extractSection = (readme, heading) => {
  const lines = readme.split(/\r?\n/)
  const idx = lines.findIndex((line) => line.trim().toLowerCase() === heading.trim().toLowerCase())
  if (idx === -1) return ''
  const out = []
  for (let i = idx + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (/^##\s+/.test(line) && i > idx + 1) break
    out.push(line)
  }
  return out.join('\n').trim()
}

const gatherExamples = async () => {
  const dir = path.join(root, 'examples')
  const entries = await readdir(dir)
  const files = []
  for (const name of entries) {
    const full = path.join(dir, name)
    const st = await stat(full)
    if (st.isFile()) files.push(name)
  }
  files.sort()
  const items = []
  for (const name of files) {
    const content = await readUtf8(path.join(dir, name))
    items.push({ title: `examples/${name}`, body: content.trimEnd() })
  }
  return items
}

const gatherTests = async () => {
  const tests = []
  const srcDir = path.join(root, 'src')

  const findSpecFiles = async (dir) => {
    const entries = await readdir(dir, { withFileTypes: true })
    const found = []
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        found.push(...(await findSpecFiles(full)))
      } else if (
        entry.isFile() &&
        (entry.name.endsWith('.spec.ts') || entry.name.endsWith('.spec.mjs'))
      ) {
        found.push(full)
      }
    }
    return found
  }

  try {
    const specFiles = await findSpecFiles(srcDir)
    for (const file of specFiles) {
      const body = await readUtf8(file)
      const title = toPosix(path.relative(root, file))
      tests.push({ title, body: body.trimEnd() })
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }

  return tests
}

const main = async () => {
  const readme = await readUtf8(path.join(root, 'README.md'))
  const caption = extractCaption(readme)
  const whatYouGet = extractSection(readme, '## What you get')
  const api = await readUtf8(path.join(root, 'docs/api.md'))
  const examples = await gatherExamples()
  const tests = await gatherTests()

  const sections = [
    { title: 'README caption', body: caption },
    { title: 'README: What you get', body: whatYouGet },
    { title: 'docs/api.md', body: api.trimEnd() },
    ...examples,
    ...tests,
  ]

  const distDir = path.join(root, 'dist')
  await mkdir(distDir, { recursive: true })
  const outputPath = path.join(distDir, 'llms.txt')

  const content = sections
    .map((section) => `=== ${section.title} ===\n${section.body}\n`)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')

  await writeFile(outputPath, `${content.trimEnd()}\n`, 'utf8')
  console.log(`Wrote ${outputPath}`)
}

await main()
