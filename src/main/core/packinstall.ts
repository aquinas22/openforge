import AdmZip from 'adm-zip'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import type { LoaderType, ManualDownload, Provider } from '@shared/types'
import { GamePaths } from './paths'
import { CfClient } from './curseforge'
import { ModrinthClient } from './modrinth'
import { DownloadTask, downloadAllSettled, downloadFile } from './http'
import type { Reporter } from './installer'

/**
 * Installs a published modpack into an instance, from either provider.
 *
 * CurseForge packs are a zip with `manifest.json` listing project/file id pairs
 * plus an `overrides/` tree. Modrinth packs (`.mrpack`) are a zip with
 * `modrinth.index.json` listing direct CDN urls and hashes plus the same kind of
 * overrides tree. Both end up in the same place, and both record exactly which
 * files they wrote so a later update can clean up after itself without ever
 * touching the player's worlds.
 */

export interface PackInstallResult {
  mcVersion: string
  loader: LoaderType
  loaderVersion?: string
  name: string
  packVersion?: string
  totalFiles: number
  failed: number
  manualDownloads: ManualDownload[]
}

/** Files a pack install wrote, so the next update can remove what it dropped. */
interface PackIndex {
  provider: Provider
  projectId: string
  versionId: string
  packVersion?: string
  /** Instance-relative paths, POSIX separators. */
  files: string[]
}

const PACK_INDEX = '.openforge-pack.json'

/** Never overwrite or prune anything under these - they are the player's. */
const USER_OWNED = ['saves', 'screenshots', 'logs', 'crash-reports', 'backups']

export async function readPackIndex(instanceDir: string): Promise<PackIndex | null> {
  try {
    return JSON.parse(await readFile(join(instanceDir, PACK_INDEX), 'utf8')) as PackIndex
  } catch {
    return null
  }
}

async function writePackIndex(instanceDir: string, index: PackIndex): Promise<void> {
  await writeFile(join(instanceDir, PACK_INDEX), JSON.stringify(index, null, 2))
}

function isUserOwned(relPath: string): boolean {
  const head = relPath.split('/')[0]
  return USER_OWNED.includes(head)
}

/**
 * Resolve an archive entry to an absolute path inside the instance, refusing
 * anything that escapes it. Modpack zips are third-party content, and `../`
 * entries (zip slip) would otherwise let one write anywhere on disk.
 */
function safeJoin(root: string, relPath: string): string | null {
  const target = resolve(root, relPath)
  const rel = relative(root, target)
  if (!rel || rel.startsWith('..') || rel.startsWith(`..${sep}`)) return null
  return target
}

/** "forge-47.2.0" / "neoforge-20.4.190" / "fabric-0.15.0" -> {type, version} */
export function parseLoaderId(id: string): { type: LoaderType; version: string } {
  const dash = id.indexOf('-')
  const rawType = (dash >= 0 ? id.slice(0, dash) : id).toLowerCase()
  const version = dash >= 0 ? id.slice(dash + 1) : ''
  const type: LoaderType =
    rawType === 'fabric'
      ? 'fabric'
      : rawType === 'quilt'
        ? 'quilt'
        : rawType === 'neoforge'
          ? 'neoforge'
          : rawType === 'forge'
            ? 'forge'
            : 'vanilla'
  return { type, version }
}

// -- Shared steps -------------------------------------------------------------

/**
 * Remove the files a previous install of this pack wrote which the new version
 * no longer contains. Keeps worlds, screenshots, and anything the player added
 * by hand, so updating a pack never costs someone their base.
 */
async function pruneStaleFiles(instanceDir: string, keep: Set<string>): Promise<number> {
  const previous = await readPackIndex(instanceDir)
  if (!previous) return 0
  let removed = 0
  for (const relPath of previous.files) {
    if (keep.has(relPath) || isUserOwned(relPath)) continue
    const target = safeJoin(instanceDir, relPath)
    if (!target || !existsSync(target)) continue
    await rm(target, { force: true }).catch(() => undefined)
    removed++
  }
  return removed
}

/** Extract every entry under one of the override roots into the instance. */
async function applyOverrides(
  zip: AdmZip,
  instanceDir: string,
  roots: string[],
  written: Set<string>,
  isUpdate: boolean
): Promise<void> {
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue
    const name = entry.entryName.replace(/\\/g, '/')
    for (const root of roots) {
      const prefix = root.endsWith('/') ? root : `${root}/`
      if (!name.startsWith(prefix)) continue
      const rel = name.slice(prefix.length)
      if (!rel) continue
      // An update must not stomp a world or a screenshot folder shipped in
      // overrides; a first install is free to lay them down.
      if (isUpdate && isUserOwned(rel)) continue
      const target = safeJoin(instanceDir, rel)
      if (!target) continue
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, entry.getData())
      written.add(rel)
    }
  }
}

async function downloadPackArchive(
  url: string,
  fileName: string,
  report: Reporter,
  mirrors?: string[]
): Promise<string> {
  const dest = join(tmpdir(), `openforge-pack-${Date.now()}-${fileName.replace(/[^\w.-]/g, '_')}`)
  report('preparing', 'Downloading modpack', -1, fileName)
  await downloadFile({ url, dest, mirrors })
  return dest
}

// -- Modrinth (.mrpack) -------------------------------------------------------

interface MrpackIndex {
  formatVersion: number
  game: string
  versionId: string
  name: string
  summary?: string
  files: {
    path: string
    hashes?: { sha1?: string; sha512?: string }
    env?: { client?: string; server?: string }
    downloads: string[]
    fileSize?: number
  }[]
  dependencies: Record<string, string>
}

/** Map an .mrpack `dependencies` object onto our loader model. */
function loaderFromMrpack(dependencies: Record<string, string>): {
  mcVersion: string
  loader: LoaderType
  loaderVersion?: string
} {
  const mcVersion = dependencies['minecraft'] ?? ''
  if (dependencies['fabric-loader']) {
    return { mcVersion, loader: 'fabric', loaderVersion: dependencies['fabric-loader'] }
  }
  if (dependencies['quilt-loader']) {
    return { mcVersion, loader: 'quilt', loaderVersion: dependencies['quilt-loader'] }
  }
  if (dependencies['neoforge']) {
    return { mcVersion, loader: 'neoforge', loaderVersion: dependencies['neoforge'] }
  }
  if (dependencies['forge']) {
    return { mcVersion, loader: 'forge', loaderVersion: dependencies['forge'] }
  }
  return { mcVersion, loader: 'vanilla' }
}

export async function installMrpackArchive(opts: {
  archivePath: string
  instanceDir: string
  report: Reporter
  concurrency: number
  provider?: Provider
  projectId?: string
  versionId?: string
  /** Delete the archive when done (false for a user's own file). */
  cleanupArchive?: boolean
}): Promise<PackInstallResult> {
  const { archivePath, instanceDir, report, concurrency } = opts
  await mkdir(instanceDir, { recursive: true })

  const zip = new AdmZip(archivePath)
  const indexEntry = zip.getEntry('modrinth.index.json')
  if (!indexEntry) {
    throw new Error('This file is not a Modrinth modpack (no modrinth.index.json).')
  }
  const index: MrpackIndex = JSON.parse(zip.readAsText(indexEntry))
  const { mcVersion, loader, loaderVersion } = loaderFromMrpack(index.dependencies ?? {})
  if (!mcVersion) throw new Error('This modpack does not declare a Minecraft version.')

  const isUpdate = (await readPackIndex(instanceDir)) !== null
  const written = new Set<string>()

  // Files the pack pulls straight from a CDN, hash-verified.
  const tasks: DownloadTask[] = []
  for (const file of index.files ?? []) {
    // "unsupported" on the client means a server-only mod; installing it breaks
    // the client, so skip it the way the Modrinth launcher does.
    if (file.env?.client === 'unsupported') continue
    const relPath = file.path.replace(/\\/g, '/')
    const target = safeJoin(instanceDir, relPath)
    if (!target) continue
    const [primary, ...mirrors] = file.downloads ?? []
    if (!primary) continue
    tasks.push({
      url: primary,
      mirrors,
      dest: target,
      sha512: file.hashes?.sha512,
      sha1: file.hashes?.sha1,
      size: file.fileSize
    })
    written.add(relPath)
  }

  report('mods', 'Downloading pack files', 0, `0/${tasks.length}`)
  const { failed } = await downloadAllSettled(tasks, concurrency, (done, total) =>
    report('mods', 'Downloading pack files', total ? done / total : 1, `${done}/${total}`)
  )
  for (const entry of failed) written.delete(relativeTo(instanceDir, entry.task.dest))

  report('overrides', 'Applying pack files', -1)
  await applyOverrides(zip, instanceDir, ['overrides', 'client-overrides'], written, isUpdate)

  const pruned = await pruneStaleFiles(instanceDir, written)
  if (pruned) report('overrides', 'Removed files from the previous version', -1, `${pruned} files`)

  await writePackIndex(instanceDir, {
    provider: opts.provider ?? 'modrinth',
    projectId: opts.projectId ?? '',
    versionId: opts.versionId ?? index.versionId,
    packVersion: index.versionId,
    files: [...written]
  })

  if (opts.cleanupArchive !== false) await rm(archivePath, { force: true }).catch(() => undefined)
  report('mods', 'Pack files ready', 1, `${written.size} files`)

  return {
    mcVersion,
    loader,
    loaderVersion,
    name: index.name ?? 'Modrinth Modpack',
    packVersion: index.versionId,
    totalFiles: tasks.length,
    failed: failed.length,
    manualDownloads: []
  }
}

function relativeTo(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join('/')
}

// -- CurseForge ---------------------------------------------------------------

interface CfManifest {
  minecraft: { version: string; modLoaders: { id: string; primary?: boolean }[] }
  name?: string
  version?: string
  author?: string
  files: { projectID: number; fileID: number; required?: boolean }[]
  overrides?: string
}

export async function installCurseForgeArchive(opts: {
  cf: CfClient
  archivePath: string
  instanceDir: string
  report: Reporter
  concurrency: number
  projectId?: string
  versionId?: string
  cleanupArchive?: boolean
}): Promise<PackInstallResult> {
  const { cf, archivePath, instanceDir, report, concurrency } = opts
  await mkdir(instanceDir, { recursive: true })

  const zip = new AdmZip(archivePath)
  const manifestEntry = zip.getEntry('manifest.json')
  if (!manifestEntry) throw new Error('This file is not a CurseForge modpack (no manifest.json).')
  const manifest: CfManifest = JSON.parse(zip.readAsText(manifestEntry))

  const mcVersion = manifest.minecraft.version
  const primaryLoader =
    manifest.minecraft.modLoaders.find((l) => l.primary) ?? manifest.minecraft.modLoaders[0]
  const { type: loader, version: loaderVersion } = primaryLoader
    ? parseLoaderId(primaryLoader.id)
    : { type: 'vanilla' as LoaderType, version: '' }

  const isUpdate = (await readPackIndex(instanceDir)) !== null
  const written = new Set<string>()

  // -- Resolve every mod file in as few requests as the transport allows -----
  const refs = (manifest.files ?? []).filter((f) => f.required !== false)
  report('mods', 'Resolving mods', -1, `${refs.length} files`)
  const versions = await cf.getVersionsBulk(
    refs.map((r) => ({ projectId: String(r.projectID), versionId: String(r.fileID) }))
  )

  const modsDir = join(instanceDir, 'mods')
  await mkdir(modsDir, { recursive: true })

  const tasks: DownloadTask[] = []
  const manualDownloads: ManualDownload[] = []
  const unresolved: string[] = []

  let resolved = 0
  for (const ref of refs) {
    const version = versions.get(String(ref.fileID))
    resolved++
    if (resolved % 25 === 0) {
      report('mods', 'Resolving mods', resolved / Math.max(refs.length, 1), `${resolved}/${refs.length}`)
    }
    if (!version) {
      unresolved.push(String(ref.projectID))
      continue
    }
    // Resource packs and shaders shipped as pack files belong in their own
    // folders, not in mods/ - CurseForge encodes that only in the file name.
    const relPath = `${folderForFile(version.fileName)}/${version.fileName}`
    const target = safeJoin(instanceDir, relPath)
    if (!target) continue
    const url = version.downloadUrl ?? (await cf.resolveDownloadUrl(String(ref.projectID), version))
    tasks.push({
      url,
      mirrors: version.mirrors,
      dest: target,
      sha1: version.sha1,
      size: version.fileSize
    })
    written.add(relPath)
  }

  report('mods', 'Downloading mods', 0, `0/${tasks.length}`)
  const { failed } = await downloadAllSettled(tasks, concurrency, (done, total) =>
    report('mods', 'Downloading mods', total ? done / total : 1, `${done}/${total}`)
  )

  // Anything we could not fetch becomes an actionable list with real links
  // rather than a number the player can do nothing about.
  const blockedIds = [...unresolved]
  for (const entry of failed) {
    written.delete(relativeTo(instanceDir, entry.task.dest))
  }
  if (blockedIds.length || failed.length) {
    const projects = await cf.getProjectsBulk(blockedIds).catch(() => new Map())
    for (const id of blockedIds) {
      const project = projects.get(id)
      manualDownloads.push({
        name: project?.name ?? `CurseForge project ${id}`,
        fileName: '',
        pageUrl: project?.pageUrl ?? `https://www.curseforge.com/minecraft/mc-mods/${id}`
      })
    }
    for (const entry of failed) {
      manualDownloads.push({
        name: entry.task.dest.split(/[\\/]/).pop() ?? 'Unknown file',
        fileName: entry.task.dest.split(/[\\/]/).pop() ?? '',
        pageUrl: entry.task.url
      })
    }
  }

  report('overrides', 'Applying pack files', -1)
  const overridesRoot = manifest.overrides ?? 'overrides'
  await applyOverrides(zip, instanceDir, [overridesRoot, 'client-overrides'], written, isUpdate)

  const pruned = await pruneStaleFiles(instanceDir, written)
  if (pruned) report('overrides', 'Removed files from the previous version', -1, `${pruned} files`)

  await writePackIndex(instanceDir, {
    provider: 'curseforge',
    projectId: opts.projectId ?? '',
    versionId: opts.versionId ?? '',
    packVersion: manifest.version,
    files: [...written]
  })

  if (opts.cleanupArchive !== false) await rm(archivePath, { force: true }).catch(() => undefined)
  report('mods', 'Pack files ready', 1, `${written.size} files`)

  return {
    mcVersion,
    loader,
    loaderVersion: loaderVersion || undefined,
    name: manifest.name ?? 'CurseForge Modpack',
    packVersion: manifest.version,
    totalFiles: refs.length,
    failed: manualDownloads.length,
    manualDownloads
  }
}

/** Route a pack file to the folder its type belongs in. */
function folderForFile(fileName: string): string {
  const lower = fileName.toLowerCase()
  if (lower.endsWith('.zip')) {
    if (/shader/.test(lower)) return 'shaderpacks'
    return 'resourcepacks'
  }
  return 'mods'
}

// -- Entry point --------------------------------------------------------------

/** Download and install a published pack from either provider. */
export async function installPack(opts: {
  provider: Provider
  cf: CfClient
  modrinth: ModrinthClient
  paths: GamePaths
  instanceId: string
  projectId: string
  versionId: string
  report: Reporter
  concurrency: number
}): Promise<PackInstallResult> {
  const { provider, cf, modrinth, paths, instanceId, projectId, versionId, report } = opts
  const instanceDir = paths.instanceDir(instanceId)

  report('preparing', 'Fetching pack details', -1)

  if (provider === 'modrinth') {
    const version = await modrinth.getVersion(versionId)
    if (!version?.downloadUrl) throw new Error('Could not resolve the modpack file from Modrinth.')
    const archive = await downloadPackArchive(version.downloadUrl, version.fileName, report)
    return installMrpackArchive({
      archivePath: archive,
      instanceDir,
      report,
      concurrency: opts.concurrency,
      provider: 'modrinth',
      projectId,
      versionId
    })
  }

  const version = await cf.getVersion(projectId, versionId)
  if (!version) throw new Error('Could not resolve the modpack file from CurseForge.')
  const url = await cf.resolveDownloadUrl(projectId, version)
  const archive = await downloadPackArchive(url, version.fileName, report, version.mirrors)
  return installCurseForgeArchive({
    cf,
    archivePath: archive,
    instanceDir,
    report,
    concurrency: opts.concurrency,
    projectId,
    versionId
  })
}

/** Install a pack from a file the user picked (.mrpack or a CurseForge zip). */
export async function installPackFromFile(opts: {
  cf: CfClient
  archivePath: string
  instanceDir: string
  report: Reporter
  concurrency: number
}): Promise<PackInstallResult> {
  const zip = new AdmZip(opts.archivePath)
  if (zip.getEntry('modrinth.index.json')) {
    return installMrpackArchive({ ...opts, cleanupArchive: false, provider: 'modrinth' })
  }
  if (zip.getEntry('manifest.json')) {
    return installCurseForgeArchive({ ...opts, cleanupArchive: false })
  }
  throw new Error(
    'That file is not a modpack. Openforge accepts Modrinth .mrpack files and CurseForge pack zips.'
  )
}
