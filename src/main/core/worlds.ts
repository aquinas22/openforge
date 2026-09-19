import AdmZip from 'adm-zip'
import { existsSync } from 'node:fs'
import { mkdir, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { WorldSummary } from '@shared/types'

/**
 * Saved worlds inside an instance, and one-click backups of them.
 *
 * Backups matter more here than in a vanilla launcher: updating a modpack
 * rewrites configs and swaps mod jars, and while the installer is careful never
 * to touch `saves/`, a player about to update a 300-mod pack deserves a copy of
 * their base they can take somewhere else.
 */

async function directorySize(dir: string): Promise<number> {
  let total = 0
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) total += await directorySize(path)
    else if (entry.isFile()) total += (await stat(path).catch(() => ({ size: 0 }))).size
  }
  return total
}

export async function listWorlds(instanceDir: string): Promise<WorldSummary[]> {
  const savesDir = join(instanceDir, 'saves')
  if (!existsSync(savesDir)) return []
  const entries = await readdir(savesDir, { withFileTypes: true }).catch(() => [])
  const worlds: WorldSummary[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = join(savesDir, entry.name)
    // level.dat is gzipped NBT; its mtime is a reliable "last played" without
    // pulling in an NBT parser just to read the display name.
    const levelDat = join(dir, 'level.dat')
    const info = await stat(existsSync(levelDat) ? levelDat : dir).catch(() => null)
    worlds.push({
      folderName: entry.name,
      name: entry.name,
      lastPlayed: info?.mtimeMs,
      sizeMb: Math.round((await directorySize(dir)) / 1024 / 1024)
    })
  }
  return worlds.sort((a, b) => (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0))
}

/** Zip one world into the instance's `backups/` folder. Returns the path. */
export async function backupWorld(instanceDir: string, folderName: string): Promise<string> {
  const source = join(instanceDir, 'saves', folderName)
  if (!existsSync(source)) throw new Error(`World "${folderName}" no longer exists.`)
  const backupsDir = join(instanceDir, 'backups')
  await mkdir(backupsDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const destination = join(backupsDir, `${folderName}-${stamp}.zip`)
  const zip = new AdmZip()
  zip.addLocalFolder(source, folderName)
  await zip.writeZipPromise(destination, { overwrite: true })
  return destination
}
