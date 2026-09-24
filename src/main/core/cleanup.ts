import AdmZip from 'adm-zip'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { CleanupItem, CleanupPlan, ConfigFileEntry } from '../../shared/types'

/**
 * Mod configs and instance housekeeping.
 *
 * Nothing in here deletes anything: it lists and plans. The IPC layer moves
 * whatever the player confirms to the system trash, so every cleanup is
 * recoverable from the Recycle Bin.
 */

// -- Mod ids ------------------------------------------------------------------

/** `modId="jei"` entries from a Forge/NeoForge mods.toml. */
export function modIdsFromToml(text: string): string[] {
  return [...text.matchAll(/^\s*modId\s*=\s*["']([^"']+)["']/gm)].map((m) => m[1])
}

/** The id from fabric.mod.json or quilt.mod.json. */
export function modIdFromJson(text: string): string | null {
  try {
    const data = JSON.parse(text) as { id?: string; quilt_loader?: { id?: string } }
    return data.quilt_loader?.id ?? data.id ?? null
  } catch {
    return null
  }
}

/** Ids a mod jar declares, plus the names of the jars it bundles (jar-in-jar). */
export function readModIds(jarPath: string): string[] {
  const ids = new Set<string>()
  try {
    const zip = new AdmZip(jarPath)
    for (const name of ['META-INF/mods.toml', 'META-INF/neoforge.mods.toml']) {
      const entry = zip.getEntry(name)
      if (entry) modIdsFromToml(zip.readAsText(entry)).forEach((id) => ids.add(id))
    }
    for (const name of ['fabric.mod.json', 'quilt.mod.json']) {
      const entry = zip.getEntry(name)
      const id = entry ? modIdFromJson(zip.readAsText(entry)) : null
      if (id) ids.add(id)
    }
    for (const entry of zip.getEntries()) {
      const nested = entry.entryName.match(/^META-INF\/(?:jars|jarjar)\/([^/]+)\.jar$/)
      if (nested) ids.add(nested[1])
    }
  } catch {
    /* not a readable jar: contributes no ids */
  }
  return [...ids]
}

interface ModIdCache {
  [fileName: string]: { size: number; mtimeMs: number; ids: string[] }
}

/**
 * Ids of every mod in the instance, enabled or disabled (a disabled mod still
 * owns its config). Opening a jar reads it whole, so results are cached per
 * file size and mtime in `.openforge/modids.json`.
 */
export async function installedModIds(instanceDir: string): Promise<string[]> {
  const modsDir = join(instanceDir, 'mods')
  if (!existsSync(modsDir)) return []
  const cachePath = join(instanceDir, '.openforge', 'modids.json')
  let cache: ModIdCache = {}
  try {
    cache = JSON.parse(await readFile(cachePath, 'utf8')) as ModIdCache
  } catch {
    cache = {}
  }
  const next: ModIdCache = {}
  const ids = new Set<string>()
  for (const name of await readdir(modsDir)) {
    if (!/\.jar(\.disabled)?$/i.test(name)) continue
    const st = await stat(join(modsDir, name)).catch(() => null)
    if (!st?.isFile()) continue
    const hit = cache[name]
    const found =
      hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs ? hit.ids : readModIds(join(modsDir, name))
    next[name] = { size: st.size, mtimeMs: st.mtimeMs, ids: found }
    found.forEach((id) => ids.add(id))
    // The file name itself is a useful hint ("sodium-fabric-0.5.jar").
    ids.add(name.replace(/\.jar(\.disabled)?$/i, ''))
  }
  await mkdir(join(instanceDir, '.openforge'), { recursive: true })
  await writeFile(cachePath, JSON.stringify(next)).catch(() => undefined)
  return [...ids]
}

// -- Config ownership ------------------------------------------------------------

/** Config names that belong to the loader or the game, never to a mod. */
const LOADER_OWNERS = ['forge', 'neoforge', 'fml', 'fabric', 'quilt', 'minecraft', 'openforge']

const normalize = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]/g, '')

/** Which mod a config path most likely belongs to: its folder, or its file stem. */
export function configOwner(relPath: string): string {
  const parts = relPath.split(/[\\/]/).filter(Boolean)
  if (parts[0] === 'config') parts.shift()
  const first = parts[0] ?? ''
  if (parts.length > 1) return first
  return first
    .replace(/\.[^.]+$/, '')
    .replace(/[-_.](client|common|server|options|config|settings|mixins?)$/i, '')
}

/**
 * Whether a config appears to belong to no installed mod. Deliberately
 * conservative: loader configs, very short names, and anything that shares a
 * prefix with an installed id are kept.
 */
export function isOrphanConfig(relPath: string, installedIds: string[]): boolean {
  const owner = normalize(configOwner(relPath))
  if (owner.length < 3) return false
  if (LOADER_OWNERS.some((name) => owner.startsWith(name))) return false
  for (const raw of installedIds) {
    const id = normalize(raw)
    if (id.length < 3) {
      if (id && owner === id) return false
      continue
    }
    if (owner === id || owner.startsWith(id) || id.startsWith(owner)) return false
  }
  return true
}

async function walk(dir: string, depth: number, out: string[]): Promise<void> {
  if (depth < 0) return
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) await walk(path, depth - 1, out)
    else if (entry.isFile()) out.push(path)
  }
}

/** Config files under `config/` (and `defaultconfigs/`), owners and orphan flags included. */
export async function listConfigFiles(instanceDir: string, installedIds: string[] | null): Promise<ConfigFileEntry[]> {
  const files: string[] = []
  for (const root of ['config', 'defaultconfigs']) {
    const dir = join(instanceDir, root)
    if (existsSync(dir)) await walk(dir, 4, files)
  }
  const entries: ConfigFileEntry[] = []
  for (const path of files) {
    const st = await stat(path).catch(() => null)
    if (!st) continue
    const relPath = relative(instanceDir, path).split(sep).join('/')
    entries.push({
      relPath,
      size: st.size,
      modified: st.mtimeMs,
      owner: configOwner(relPath),
      orphan: installedIds ? isOrphanConfig(relPath, installedIds) : false
    })
  }
  return entries.sort((a, b) => a.relPath.localeCompare(b.relPath))
}

// -- Cleanup planning ---------------------------------------------------------------

/** Regenerable folders inside an instance. The game or loader recreates each on demand. */
export const CLEANUP_TARGETS: { relPath: string; label: string; reason: string; category: CleanupItem['category'] }[] = [
  { relPath: 'logs', label: 'Game logs', reason: 'Old log files. The game starts a new one each launch.', category: 'logs' },
  { relPath: 'crash-reports', label: 'Crash reports', reason: 'Reports from past crashes. Keep them if you are still debugging one.', category: 'crash' },
  { relPath: 'debug', label: 'Debug output', reason: 'Profiler and debug dumps.', category: 'logs' },
  { relPath: '.cache', label: 'Mod caches', reason: 'Caches mods rebuild on the next start.', category: 'cache' },
  { relPath: '.fabric/processedMods', label: 'Fabric remap cache', reason: 'Fabric rebuilds it on the next start.', category: 'cache' },
  { relPath: '.mixin.out', label: 'Mixin debug output', reason: 'Written only when mixin debugging is on.', category: 'cache' },
  { relPath: 'shadercache', label: 'Shader cache', reason: 'Compiled shader programs, rebuilt when needed.', category: 'cache' },
  { relPath: 'modernfix', label: 'ModernFix cache', reason: 'Startup cache ModernFix rebuilds automatically.', category: 'cache' }
]

export interface SizedPath {
  relPath: string
  bytes: number
  files: number
}

/**
 * Turn what exists on disk into a cleanup plan. Pure: callers pass sizes for
 * the targets that exist and the orphaned configs they found.
 */
export function buildCleanupPlan(existing: SizedPath[], orphanConfigs: SizedPath[]): CleanupPlan {
  const items: CleanupItem[] = []
  for (const target of CLEANUP_TARGETS) {
    const hit = existing.find((entry) => entry.relPath === target.relPath)
    if (!hit || hit.files === 0) continue
    items.push({ ...target, bytes: hit.bytes, files: hit.files, recommended: true })
  }
  for (const orphan of orphanConfigs) {
    items.push({
      relPath: orphan.relPath,
      label: orphan.relPath.replace(/^config\//, ''),
      reason: `No installed mod matches "${configOwner(orphan.relPath)}".`,
      category: 'orphan-config',
      bytes: orphan.bytes,
      files: orphan.files,
      // Name matching is a heuristic; the player opts in to each of these.
      recommended: false
    })
  }
  return { items, totalBytes: items.reduce((sum, item) => sum + item.bytes, 0) }
}

async function sizeOf(path: string): Promise<{ bytes: number; files: number }> {
  const st = await stat(path).catch(() => null)
  if (!st) return { bytes: 0, files: 0 }
  if (st.isFile()) return { bytes: st.size, files: 1 }
  let bytes = 0
  let files = 0
  const entries = await readdir(path, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const child = await sizeOf(join(path, entry.name))
    bytes += child.bytes
    files += child.files
  }
  return { bytes, files }
}

/** Scan an instance and build its cleanup plan. */
export async function planCleanup(instanceDir: string, modded: boolean): Promise<CleanupPlan> {
  const existing: SizedPath[] = []
  for (const target of CLEANUP_TARGETS) {
    const path = join(instanceDir, ...target.relPath.split('/'))
    if (!existsSync(path)) continue
    existing.push({ relPath: target.relPath, ...(await sizeOf(path)) })
  }
  const orphans: SizedPath[] = []
  if (modded) {
    const ids = await installedModIds(instanceDir)
    // With no readable mods every config would look orphaned; say nothing instead.
    if (ids.length) {
      // Group orphans by their top-level entry, so a mod's config folder is one item.
      const configs = await listConfigFiles(instanceDir, ids)
      const tops = new Map<string, boolean>()
      for (const config of configs) {
        const parts = config.relPath.split('/')
        const top = parts.length > 2 ? parts.slice(0, 2).join('/') : config.relPath
        tops.set(top, (tops.get(top) ?? true) && config.orphan)
      }
      for (const [top, orphan] of tops) {
        if (!orphan) continue
        orphans.push({ relPath: top, ...(await sizeOf(join(instanceDir, ...top.split('/')))) })
      }
    }
  }
  return buildCleanupPlan(existing, orphans)
}
