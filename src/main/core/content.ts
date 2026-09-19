import AdmZip from 'adm-zip'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type {
  ContentKind,
  ContentVersion,
  Instance,
  InstalledMod,
  ModInstallResult,
  Provider
} from '@shared/types'
import { CfClient } from './curseforge'
import { ModrinthClient } from './modrinth'
import { downloadFile } from './http'

/**
 * Everything that lives inside an instance and can be added, toggled, updated,
 * or removed: mods, texture packs, shader packs, and data packs.
 *
 * They only differ by which folder they land in and which file extensions
 * count, so one manager covers all of them - which is why installing a texture
 * pack works exactly like installing a mod, all the way down to dependency
 * resolution and update checks.
 */

export const FOLDER: Record<ContentKind, string> = {
  mod: 'mods',
  resourcepack: 'resourcepacks',
  shader: 'shaderpacks',
  datapack: 'datapacks',
  modpack: '.'
}

const EXTENSIONS: Record<ContentKind, RegExp> = {
  mod: /\.jar(?:\.disabled)?$/i,
  resourcepack: /\.zip(?:\.disabled)?$/i,
  shader: /\.zip(?:\.disabled)?$/i,
  datapack: /\.zip(?:\.disabled)?$/i,
  modpack: /$^/
}

interface ContentRecord {
  kind: ContentKind
  fileName: string
  provider: Provider
  projectId: string
  versionId: string
  name: string
  version: string
  sha512?: string
}

interface ContentIndex {
  entries: ContentRecord[]
}

const INDEX_NAME = '.openforge-content.json'
const LEGACY_INDEX_NAMES = ['.openforge-mods.json', '.arsfodina-mods.json']

// -- Index ---------------------------------------------------------------------

async function readIndex(instanceDir: string): Promise<ContentIndex> {
  try {
    const raw = await readFile(join(instanceDir, INDEX_NAME), 'utf8')
    const parsed = JSON.parse(raw) as ContentIndex
    if (Array.isArray(parsed.entries)) return parsed
  } catch {
    /* fall through to the legacy formats */
  }
  // Pre-2.0 instances tracked CurseForge mods only, with numeric ids.
  for (const legacy of LEGACY_INDEX_NAMES) {
    try {
      const raw = await readFile(join(instanceDir, legacy), 'utf8')
      const parsed = JSON.parse(raw) as {
        mods?: { projectId: number; fileId: number; fileName: string; name: string; version: string }[]
      }
      if (Array.isArray(parsed.mods)) {
        return {
          entries: parsed.mods.map((mod) => ({
            kind: 'mod' as const,
            fileName: mod.fileName,
            provider: 'curseforge' as const,
            projectId: String(mod.projectId),
            versionId: String(mod.fileId),
            name: mod.name,
            version: mod.version
          }))
        }
      }
    } catch {
      /* try the next one */
    }
  }
  return { entries: [] }
}

async function saveIndex(instanceDir: string, index: ContentIndex): Promise<void> {
  await writeFile(join(instanceDir, INDEX_NAME), JSON.stringify(index, null, 2))
}

export async function forgetContent(instanceDir: string, fileName: string): Promise<void> {
  const index = await readIndex(instanceDir)
  const bare = fileName.replace(/\.disabled$/i, '')
  index.entries = index.entries.filter((entry) => entry.fileName !== bare)
  await saveIndex(instanceDir, index)
}

// -- Listing --------------------------------------------------------------------

async function sha512Of(path: string): Promise<string> {
  return createHash('sha512')
    .update(await readFile(path))
    .digest('hex')
}

/** Everything installed for one kind, with provider metadata where we have it. */
export async function listContent(instanceDir: string, kind: ContentKind): Promise<InstalledMod[]> {
  const dir = join(instanceDir, FOLDER[kind])
  await mkdir(dir, { recursive: true })
  const index = await readIndex(instanceDir)
  const names = (await readdir(dir)).filter((name) => EXTENSIONS[kind].test(name))

  const items = await Promise.all(
    names.map(async (fileName) => {
      const info = await stat(join(dir, fileName))
      const enabled = !fileName.toLowerCase().endsWith('.disabled')
      const bare = enabled ? fileName : fileName.slice(0, -'.disabled'.length)
      const record = index.entries.find((entry) => entry.fileName === bare)
      return {
        fileName,
        displayName: record?.name ?? prettyName(bare),
        enabled,
        size: info.size,
        provider: record?.provider,
        projectId: record?.projectId,
        versionId: record?.versionId,
        version: record?.version,
        kind
      } satisfies InstalledMod
    })
  )
  return items.sort((a, b) => a.displayName.localeCompare(b.displayName))
}

function prettyName(fileName: string): string {
  return fileName.replace(/\.(jar|zip)$/i, '').replace(/[-_]+/g, ' ')
}

// -- Compatibility ---------------------------------------------------------------

/**
 * Loader compatibility only constrains mods. A texture pack or shader works on
 * any loader, so filtering those by loader (as launchers often do) would hide
 * almost everything.
 */
function isCompatible(version: ContentVersion, instance: Instance, kind: ContentKind): boolean {
  if (version.isServerPack) return false
  if (version.gameVersions.length && !version.gameVersions.includes(instance.mcVersion)) return false
  if (kind !== 'mod') return true
  if (instance.loader === 'vanilla' || version.loaders.length === 0) return true
  const wanted = instance.loader === 'neoforge' ? /neo\s*forge/i : new RegExp(instance.loader, 'i')
  // Quilt runs Fabric mods, so accept either for a Quilt instance.
  const quiltFallback = instance.loader === 'quilt' ? /fabric|quilt/i : null
  return version.loaders.some((name) => wanted.test(name) || quiltFallback?.test(name))
}

function pickVersion(
  versions: ContentVersion[],
  instance: Instance,
  kind: ContentKind
): ContentVersion | null {
  const compatible = versions.filter((v) => isCompatible(v, instance, kind))
  // Prefer a stable release over a beta the author also published for this
  // version; fall back to whatever is newest if there is no release at all.
  return (
    compatible.find((v) => v.releaseType === 'release') ??
    compatible[0] ??
    null
  )
}

// -- Installing -------------------------------------------------------------------

export interface ContentClients {
  cf: CfClient
  modrinth: ModrinthClient
}

async function versionsFor(
  clients: ContentClients,
  provider: Provider,
  projectId: string
): Promise<ContentVersion[]> {
  return provider === 'modrinth'
    ? clients.modrinth.getVersions(projectId)
    : clients.cf.getVersions(projectId, 0, 50)
}

async function nameFor(
  clients: ContentClients,
  provider: Provider,
  projectId: string
): Promise<string> {
  try {
    const project =
      provider === 'modrinth'
        ? await clients.modrinth.getProject(projectId)
        : await clients.cf.getProject(projectId)
    return project.name
  } catch {
    return `Project ${projectId}`
  }
}

/**
 * Install one project into an instance, pulling in its required dependencies.
 *
 * Dependency resolution is breadth-limited by a visited set, because mod graphs
 * are cyclic often enough (two mods that each list the other as required) that
 * a naive recursion will not terminate.
 */
export async function installContent(opts: {
  clients: ContentClients
  instance: Instance
  instanceDir: string
  provider: Provider
  projectId: string
  kind: ContentKind
  /** Install this exact version instead of the best compatible one. */
  versionId?: string
}): Promise<ModInstallResult> {
  const { clients, instance, instanceDir, provider, kind } = opts
  const index = await readIndex(instanceDir)
  const installed: string[] = []
  const dependencies: string[] = []
  const failed: string[] = []
  const visited = new Set<string>()

  const targetDir = join(instanceDir, FOLDER[kind])
  await mkdir(targetDir, { recursive: true })

  const installProject = async (
    projectId: string,
    wantedVersionId: string | undefined,
    isDependency: boolean
  ): Promise<void> => {
    if (visited.has(projectId)) return
    visited.add(projectId)

    const versions = await versionsFor(clients, provider, projectId)
    const version = wantedVersionId
      ? (versions.find((v) => v.id === wantedVersionId) ?? null)
      : pickVersion(versions, instance, kind)

    if (!version) {
      const name = await nameFor(clients, provider, projectId)
      const detail = kind === 'mod' ? `${instance.mcVersion} ${instance.loader}` : instance.mcVersion
      if (isDependency) {
        failed.push(`${name} (no ${detail} build)`)
        return
      }
      throw new Error(`${name} has no ${detail} build.`)
    }

    // Dependencies first, so a mod is never briefly present without them.
    for (const dep of version.dependencies ?? []) {
      if (dep.projectId) await installProject(dep.projectId, dep.versionId, true)
    }

    const name = await nameFor(clients, provider, projectId)
    const previous = index.entries.find(
      (entry) => entry.provider === provider && entry.projectId === projectId
    )
    // Retire the old jar before writing the new one, or the game loads both.
    if (previous && previous.fileName !== version.fileName) {
      for (const candidate of [previous.fileName, `${previous.fileName}.disabled`]) {
        const oldPath = join(instanceDir, FOLDER[previous.kind] ?? FOLDER[kind], candidate)
        if (existsSync(oldPath)) await rm(oldPath, { force: true })
      }
    }

    const url =
      version.downloadUrl ??
      (provider === 'curseforge' ? await clients.cf.resolveDownloadUrl(projectId, version) : null)
    if (!url) {
      failed.push(`${name} (the author disabled third-party downloads)`)
      return
    }

    await downloadFile({
      url,
      mirrors: version.mirrors,
      dest: join(targetDir, version.fileName),
      sha512: version.sha512,
      sha1: version.sha1,
      size: version.fileSize
    })

    const record: ContentRecord = {
      kind,
      fileName: version.fileName,
      provider,
      projectId,
      versionId: version.id,
      name,
      version: version.versionNumber,
      sha512: version.sha512
    }
    index.entries = [
      ...index.entries.filter(
        (entry) => !(entry.provider === provider && entry.projectId === projectId)
      ),
      record
    ]
    ;(isDependency ? dependencies : installed).push(name)
  }

  await installProject(opts.projectId, opts.versionId, false)
  await saveIndex(instanceDir, index)

  // A newly added texture pack that is not switched on looks broken; turn it on.
  if (kind === 'resourcepack' && installed.length) {
    await enableResourcePacks(
      instanceDir,
      index.entries.filter((entry) => entry.kind === 'resourcepack').map((entry) => entry.fileName)
    )
  }

  return { mods: [], installed, dependencies, failed }
}

/** Install a local file the user dragged in or picked from disk. */
export async function importLocalFile(
  instanceDir: string,
  kind: ContentKind,
  sourcePath: string
): Promise<void> {
  const dir = join(instanceDir, FOLDER[kind])
  await mkdir(dir, { recursive: true })
  const name = basename(sourcePath)
  await writeFile(join(dir, name), await readFile(sourcePath))
}

// -- Updates ----------------------------------------------------------------------

/**
 * Ask each provider whether anything installed here has a newer build.
 *
 * Modrinth can answer for files we have no record of, by hashing them - so even
 * a hand-assembled mods folder or an imported pack gets update tracking.
 */
export async function checkForUpdates(opts: {
  clients: ContentClients
  instance: Instance
  instanceDir: string
  kind: ContentKind
}): Promise<InstalledMod[]> {
  const { clients, instance, instanceDir, kind } = opts
  const items = await listContent(instanceDir, kind)
  const dir = join(instanceDir, FOLDER[kind])

  const loaders =
    kind === 'mod'
      ? instance.loader === 'quilt'
        ? ['quilt', 'fabric']
        : [instance.loader]
      : []

  // Modrinth: one bulk call keyed by file hash.
  const hashes = new Map<string, string>()
  await Promise.all(
    items.map(async (item) => {
      try {
        hashes.set(item.fileName, await sha512Of(join(dir, item.fileName)))
      } catch {
        /* unreadable file - skip it */
      }
    })
  )
  let latest: Record<string, ContentVersion> = {}
  try {
    latest = await clients.modrinth.latestForHashes(
      [...hashes.values()],
      loaders.length ? loaders : ['minecraft'],
      [instance.mcVersion]
    )
  } catch {
    /* Modrinth unreachable - fall through to CurseForge only */
  }

  const index = await readIndex(instanceDir)
  return Promise.all(
    items.map(async (item) => {
      const hash = hashes.get(item.fileName)
      const modrinthHit = hash ? latest[hash] : undefined
      if (modrinthHit && modrinthHit.fileName !== item.fileName) {
        return {
          ...item,
          updateAvailable: {
            versionId: modrinthHit.id,
            versionNumber: modrinthHit.versionNumber
          }
        }
      }

      const record = index.entries.find(
        (entry) => entry.fileName === item.fileName.replace(/\.disabled$/i, '')
      )
      if (record?.provider !== 'curseforge' || !clients.cf.available) return item
      try {
        const versions = await clients.cf.getVersions(record.projectId, 0, 50)
        const best = pickVersion(versions, instance, kind)
        if (best && best.id !== record.versionId) {
          return { ...item, updateAvailable: { versionId: best.id, versionNumber: best.versionNumber } }
        }
      } catch {
        /* provider unavailable - report what we have */
      }
      return item
    })
  )
}

/** Apply every available update for one content kind. */
export async function updateAll(opts: {
  clients: ContentClients
  instance: Instance
  instanceDir: string
  kind: ContentKind
}): Promise<ModInstallResult> {
  const checked = await checkForUpdates(opts)
  const installed: string[] = []
  const dependencies: string[] = []
  const failed: string[] = []

  for (const item of checked) {
    if (!item.updateAvailable || !item.projectId || !item.provider) continue
    try {
      const result = await installContent({
        clients: opts.clients,
        instance: opts.instance,
        instanceDir: opts.instanceDir,
        provider: item.provider,
        projectId: item.projectId,
        kind: opts.kind,
        versionId: item.updateAvailable.versionId
      })
      installed.push(...result.installed)
      dependencies.push(...result.dependencies)
      failed.push(...(result.failed ?? []))
    } catch (err) {
      failed.push(`${item.displayName}: ${(err as Error).message}`)
    }
  }
  return { mods: [], installed, dependencies, failed }
}

// -- options.txt ------------------------------------------------------------------

/**
 * Switch texture packs on by rewriting the `resourcePacks` line in options.txt.
 *
 * Minecraft lists them innermost-first, so a newly added pack goes at the end to
 * sit on top of what is already there, and "vanilla" must stay at the front.
 */
export async function enableResourcePacks(instanceDir: string, fileNames: string[]): Promise<void> {
  const optionsPath = join(instanceDir, 'options.txt')
  let lines: string[] = []
  try {
    lines = (await readFile(optionsPath, 'utf8')).split(/\r?\n/)
  } catch {
    // No options.txt yet: the game writes one on first run, and a file holding
    // only this key is merged correctly.
  }

  const wanted = fileNames.map((name) => `file/${name}`)
  const existingLine = lines.find((line) => line.startsWith('resourcePacks:'))
  let current: string[] = []
  if (existingLine) {
    try {
      current = JSON.parse(existingLine.slice('resourcePacks:'.length)) as string[]
    } catch {
      current = []
    }
  }
  if (!current.includes('vanilla')) current.unshift('vanilla')
  for (const entry of wanted) if (!current.includes(entry)) current.push(entry)

  const rendered = `resourcePacks:${JSON.stringify(current)}`
  lines = existingLine
    ? lines.map((line) => (line.startsWith('resourcePacks:') ? rendered : line))
    : [...lines.filter(Boolean), rendered]
  await writeFile(optionsPath, lines.join('\n'), 'utf8')
}

// -- Export -----------------------------------------------------------------------

/** Write the instance out as a Modrinth .mrpack that anyone can import. */
export async function exportMrpack(opts: {
  instance: Instance
  instanceDir: string
  destination: string
}): Promise<void> {
  const index = await readIndex(opts.instanceDir)
  const zip = new AdmZip()

  const dependencies: Record<string, string> = { minecraft: opts.instance.mcVersion }
  if (opts.instance.loader === 'fabric') dependencies['fabric-loader'] = opts.instance.loaderVersion ?? ''
  if (opts.instance.loader === 'quilt') dependencies['quilt-loader'] = opts.instance.loaderVersion ?? ''
  if (opts.instance.loader === 'forge') dependencies['forge'] = opts.instance.loaderVersion ?? ''
  if (opts.instance.loader === 'neoforge') dependencies['neoforge'] = opts.instance.loaderVersion ?? ''

  // Only Modrinth-sourced files can be referenced by url; everything else is
  // carried inside the archive as an override so the pack stays complete.
  const referenced = new Set<string>()
  const files = index.entries
    .filter((entry) => entry.provider === 'modrinth' && entry.sha512)
    .map((entry) => {
      const path = `${FOLDER[entry.kind]}/${entry.fileName}`
      referenced.add(path)
      return {
        path,
        hashes: { sha512: entry.sha512 },
        env: { client: 'required', server: 'required' },
        downloads: [`https://cdn.modrinth.com/data/${entry.projectId}/versions/${entry.versionId}/${encodeURIComponent(entry.fileName)}`]
      }
    })

  zip.addFile(
    'modrinth.index.json',
    Buffer.from(
      JSON.stringify(
        {
          formatVersion: 1,
          game: 'minecraft',
          versionId: opts.instance.packVersion ?? '1.0.0',
          name: opts.instance.name,
          files,
          dependencies
        },
        null,
        2
      )
    )
  )

  for (const folder of [
    'config',
    'defaultconfigs',
    'kubejs',
    'mods',
    'resourcepacks',
    'shaderpacks',
    'datapacks',
    'scripts'
  ]) {
    const source = join(opts.instanceDir, folder)
    if (!existsSync(source)) continue
    zip.addLocalFolder(source, `overrides/${folder}`, (path) => {
      const rel = `${folder}/${basename(path)}`
      return !referenced.has(rel) && !path.endsWith('.old') && !path.endsWith('.part')
    })
  }

  await zip.writeZipPromise(opts.destination, { overwrite: true })
}

/** Write the instance out as a CurseForge pack zip. */
export async function exportCurseForgePack(opts: {
  instance: Instance
  instanceDir: string
  destination: string
}): Promise<void> {
  const index = await readIndex(opts.instanceDir)
  const zip = new AdmZip()
  const loaderId =
    opts.instance.loader === 'vanilla'
      ? undefined
      : `${opts.instance.loader}-${opts.instance.loaderVersion ?? ''}`.replace(/-$/, '')
  const cfEntries = index.entries.filter((entry) => entry.provider === 'curseforge')
  const manifest = {
    minecraft: {
      version: opts.instance.mcVersion,
      modLoaders: loaderId ? [{ id: loaderId, primary: true }] : []
    },
    manifestType: 'minecraftModpack',
    manifestVersion: 1,
    name: opts.instance.name,
    version: opts.instance.packVersion ?? '1.0.0',
    author: 'Openforge',
    files: cfEntries.map((entry) => ({
      projectID: Number(entry.projectId),
      fileID: Number(entry.versionId),
      required: true
    })),
    overrides: 'overrides'
  }
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)))

  const tracked = new Set(cfEntries.map((entry) => entry.fileName))
  for (const folder of [
    'config',
    'defaultconfigs',
    'kubejs',
    'resourcepacks',
    'shaderpacks',
    'datapacks',
    'scripts'
  ]) {
    const source = join(opts.instanceDir, folder)
    if (existsSync(source)) zip.addLocalFolder(source, `overrides/${folder}`)
  }
  // Preserve manually imported mods; tracked CurseForge files are represented
  // by project/file IDs and are intentionally not duplicated in overrides.
  const modsDir = join(opts.instanceDir, 'mods')
  if (existsSync(modsDir)) {
    zip.addLocalFolder(modsDir, 'overrides/mods', (path) => {
      const name = basename(path).replace(/\.disabled$/i, '')
      return !tracked.has(name) && !path.endsWith('.old') && !path.endsWith('.part')
    })
  }
  await zip.writeZipPromise(opts.destination, { overwrite: true })
}

/** Toggle a file on or off by renaming it, the way every loader expects. */
export async function toggleContent(
  instanceDir: string,
  kind: ContentKind,
  fileName: string,
  enabled: boolean
): Promise<void> {
  const dir = join(instanceDir, FOLDER[kind])
  const currentlyDisabled = fileName.toLowerCase().endsWith('.disabled')
  const target = enabled
    ? fileName.replace(/\.disabled$/i, '')
    : currentlyDisabled
      ? fileName
      : `${fileName}.disabled`
  if (target !== fileName) await rename(join(dir, fileName), join(dir, target))
}

export async function deleteContent(
  instanceDir: string,
  kind: ContentKind,
  fileName: string
): Promise<void> {
  await rm(join(instanceDir, FOLDER[kind], fileName), { force: true })
  await forgetContent(instanceDir, fileName)
}
