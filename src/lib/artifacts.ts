import { mkdir, rm, symlink } from 'node:fs/promises'
import * as path from 'node:path'

import type { ArtifactOptions } from './types.js'

const defaultDir = '.e2e-artifacts'

const safePrefix = () => `${Math.floor(Date.now() / 1000)}`

const markLastRun = async (root: string, dir: string): Promise<void> => {
  const lastRun = path.join(root, 'last-run')
  try {
    await rm(lastRun, { force: true, recursive: true })
    await symlink(path.resolve(dir), lastRun, 'junction')
  } catch {
    // best-effort only
  }
}

export type ArtifactRun = { root: string; dir: string; prefix: string }

/**
 * Prepares an artifact run directory and updates the last-run symlink.
 */
export const prepareArtifactRun = async (opts: ArtifactOptions = {}): Promise<ArtifactRun> => {
  const root = opts.artifactDir ?? defaultDir
  const prefix = opts.artifactPrefix ?? safePrefix()
  const dir = path.join(root, prefix)
  await mkdir(dir, { recursive: true })
  await markLastRun(root, dir)
  return { root, dir, prefix }
}

export const ensureArtifactPath = async (targetPath: string): Promise<void> => {
  await mkdir(path.dirname(targetPath), { recursive: true })
}

export { defaultDir as defaultArtifactDir }
