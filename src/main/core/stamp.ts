import { createHash } from 'node:crypto'
import { createReadStream, statSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Install stamps: a small JSON manifest written next to an install once every
 * file in it has been downloaded and hash-verified. A later launch compares
 * sizes and modification times (a stat per file, no reads) instead of hashing
 * hundreds of megabytes again, which is what makes a warm launch near-instant.
 *
 * A stamp is only trusted when its key matches: the key is derived from
 * whatever defines the install (the version JSON, the installer's hash), so a
 * changed profile invalidates the stamp automatically.
 */

export interface StampedFile {
  path: string
  size: number
  mtimeMs: number
  sha1?: string
}

export interface InstallStamp {
  schema: 1
  key: string
  createdAt: string
  files: StampedFile[]
  meta?: Record<string, string>
}

export type FileStat = (path: string) => { size: number; mtimeMs: number } | null

export const defaultStat: FileStat = (path) => {
  try {
    const st = statSync(path)
    return st.isFile() ? { size: st.size, mtimeMs: st.mtimeMs } : null
  } catch {
    return null
  }
}

/** A stable key for a set of inputs. Order matters; undefined is kept distinct from "". */
export function stampKey(parts: (string | number | boolean | undefined | null)[]): string {
  const hash = createHash('sha1')
  for (const part of parts) hash.update(part === undefined || part === null ? '\u0000' : String(part)).update('\u0001')
  return hash.digest('hex')
}

/**
 * Decide whether a stamp still describes what is on disk. Pure apart from the
 * injected stat, so the verification suite can exercise it with a fake disk.
 */
export function stampIsFresh(
  stamp: InstallStamp | null | undefined,
  key: string,
  stat: FileStat = defaultStat
): { fresh: boolean; reason?: string } {
  if (!stamp) return { fresh: false, reason: 'no stamp' }
  if (stamp.schema !== 1) return { fresh: false, reason: 'old stamp format' }
  if (stamp.key !== key) return { fresh: false, reason: 'install definition changed' }
  for (const file of stamp.files) {
    const st = stat(file.path)
    if (!st) return { fresh: false, reason: `missing ${file.path}` }
    if (st.size !== file.size) return { fresh: false, reason: `size changed for ${file.path}` }
    // Truncate: some filesystems report sub-millisecond precision inconsistently.
    if (Math.trunc(st.mtimeMs) !== Math.trunc(file.mtimeMs)) {
      return { fresh: false, reason: `modified ${file.path}` }
    }
  }
  return { fresh: true }
}

export async function sha1File(path: string): Promise<string> {
  const hash = createHash('sha1')
  await new Promise<void>((resolve, reject) => {
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve())
      .on('error', reject)
  })
  return hash.digest('hex')
}

export async function readStamp(path: string): Promise<InstallStamp | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as InstallStamp
    return parsed && Array.isArray(parsed.files) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Record the current state of `files`. With `hash`, each file's sha1 is stored
 * too, so a later "Repair" can prove the bytes rather than trusting mtimes.
 * Files that do not exist are skipped rather than failing the stamp.
 */
export async function writeStamp(
  stampPath: string,
  key: string,
  files: string[],
  opts: { hash?: boolean; meta?: Record<string, string>; stat?: FileStat } = {}
): Promise<InstallStamp> {
  const stat = opts.stat ?? defaultStat
  const unique = [...new Set(files)]
  const entries: StampedFile[] = []
  for (const path of unique) {
    const st = stat(path)
    if (!st) continue
    const entry: StampedFile = { path, size: st.size, mtimeMs: st.mtimeMs }
    if (opts.hash) entry.sha1 = await sha1File(path)
    entries.push(entry)
  }
  const stamp: InstallStamp = {
    schema: 1,
    key,
    createdAt: new Date().toISOString(),
    files: entries,
    meta: opts.meta
  }
  await mkdir(dirname(stampPath), { recursive: true })
  const tmp = `${stampPath}.tmp`
  await writeFile(tmp, JSON.stringify(stamp))
  await rename(tmp, stampPath)
  return stamp
}

/** Re-hash every file that carries a recorded sha1. Used by Repair. */
export async function stampHashesMatch(stamp: InstallStamp): Promise<boolean> {
  for (const file of stamp.files) {
    if (!file.sha1) continue
    try {
      if ((await sha1File(file.path)) !== file.sha1) return false
    } catch {
      return false
    }
  }
  return true
}
