import AdmZip from 'adm-zip'
import type { DeployRemoteServerInput } from '../src/shared/ipc'
import type { ContentVersion, LoaderType, RemoteServerDeployment } from '../src/shared/types'
import type { CfClient } from '../src/main/core/curseforge'
import { ModrinthClient } from '../src/main/core/modrinth'
import { downloadFile, getJson, getText } from '../src/main/core/http'
import { fetchVersionDetail, fetchVersionManifest } from '../src/main/core/manifest'
import { installerUrl } from '../src/main/core/forge'
import { join } from 'node:path'

export interface RemoteDownload {
  path: string
  urls: string[]
  size?: number
  sha1?: string
  sha512?: string
}

export interface DeploymentPlan {
  schema: 1
  name: string
  deployment: RemoteServerDeployment
  files: RemoteDownload[]
  /** Official loader installer/launcher; never a pack-provided shell script. */
  loader?: RemoteDownload
}

export function validateSlug(slug: string): void {
  if (typeof slug !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(slug)) {
    throw new Error('Use 1–64 lowercase letters, digits, dashes or underscores for the server folder.')
  }
}

export function validateDeployInput(input: DeployRemoteServerInput): void {
  validateSlug(input.slug)
  if (typeof input.requestId !== 'string' || !/^[\w-]{1,100}$/.test(input.requestId)) throw new Error('Invalid deployment request.')
  if (!input.name?.trim() || input.name.length > 60 || /[\0-\x1f\x7f]/.test(input.name)) throw new Error('Give the server a name of 1–60 characters.')
  if (!['vanilla', 'modrinth', 'curseforge'].includes(input.source)) throw new Error('Choose vanilla, Modrinth or CurseForge.')
  if (!Number.isInteger(input.ramMb) || input.ramMb < 512 || input.ramMb > 262144) throw new Error('Server memory must be 512–262144 MB.')
  if (!Number.isInteger(input.gamePort) || input.gamePort < 1 || input.gamePort > 65535) throw new Error('The Minecraft port must be 1–65535.')
  if (input.acceptEula !== true) throw new Error('Accept the Minecraft EULA before installing a server.')
}

/** All paths are relative POSIX paths, validated before extraction or downloading. */
export function safePackPath(path: string): string {
  if (typeof path !== 'string' || !path || path.length > 1000 || /[\0-\x1f\\:]/.test(path) ||
      path.startsWith('/') || path.split('/').some((p) => !p || p === '.' || p === '..')) {
    throw new Error('The pack contains an unsafe file path.')
  }
  if (path.split('/').some((p) => p.startsWith('.openforge')) || path === 'openforge-start.sh') {
    throw new Error('The pack contains a reserved OpenForge file path.')
  }
  return path
}

function httpsUrl(url: string): string {
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('Pack downloads must use HTTPS without embedded credentials.')
  return url
}

/** Reject symlinks, traversal, and oversized archives before reading any entry. */
export function validateArchive(zip: AdmZip): void {
  let total = 0
  const seen = new Set<string>()
  const entries = zip.getEntries()
  if (entries.length > 100_000) throw new Error('The pack archive has too many entries.')
  for (const entry of entries) {
    safePackPath(entry.entryName.replace(/\/$/, ''))
    const mode = (entry.attr >>> 16) & 0xf000
    if (mode && mode !== 0x8000 && mode !== 0x4000) throw new Error('Pack archives cannot contain symlinks or special files.')
    if (seen.has(entry.entryName)) throw new Error('The pack archive contains duplicate paths.')
    seen.add(entry.entryName)
    total += entry.header.size
    if (entry.header.size > 512 * 1024 * 1024 || total > 8 * 1024 * 1024 * 1024) throw new Error('The pack archive is too large to extract safely.')
  }
}

function readJson<T>(zip: AdmZip, name: string): T {
  const entry = zip.getEntry(name)
  if (!entry || entry.header.size > 4 * 1024 * 1024) throw new Error('The pack is missing a valid manifest.')
  return JSON.parse(entry.getData().toString('utf8')) as T
}

function loaderVersion(value: string): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9.+_-]{0,100}$/.test(value)) throw new Error('The pack specifies an invalid loader version.')
  return value
}

export function mrpackPlan(zip: AdmZip): { mcVersion: string; loader: LoaderType; loaderVersion?: string; files: RemoteDownload[]; overrides: AdmZip } {
  validateArchive(zip)
  const index = readJson<{
    formatVersion: number
    game: string
    dependencies: Record<string, string>
    files: { path: string; downloads: string[]; hashes: { sha1?: string; sha512?: string }; fileSize: number; env?: { server?: string } }[]
  }>(zip, 'modrinth.index.json')
  if (index.formatVersion !== 1 || index.game !== 'minecraft' || !index.dependencies?.minecraft || !Array.isArray(index.files)) {
    throw new Error('Unsupported Modrinth pack format.')
  }
  const dependencies = Object.entries(index.dependencies).filter(([key]) => key !== 'minecraft')
  const loaders: Record<string, LoaderType> = { 'fabric-loader': 'fabric', 'quilt-loader': 'quilt', forge: 'forge', neoforge: 'neoforge' }
  if (dependencies.length > 1 || dependencies.some(([key]) => !loaders[key])) throw new Error('This pack uses an unsupported combination of loaders.')
  const selected = dependencies[0]
  const files: RemoteDownload[] = []
  const seen = new Set<string>()
  for (const file of index.files) {
    // Optional server files are omitted; required/default files are installed.
    if (file.env?.server === 'unsupported' || file.env?.server === 'optional') continue
    const path = safePackPath(file.path)
    if (seen.has(path)) throw new Error('The pack lists a file more than once.')
    seen.add(path)
    if (!file.downloads?.length || !file.hashes || !(/^[a-f0-9]{128}$/i.test(file.hashes.sha512 ?? '') || /^[a-f0-9]{40}$/i.test(file.hashes.sha1 ?? ''))) {
      throw new Error('A Modrinth server file has no download URL or valid checksum.')
    }
    files.push({ path, urls: file.downloads.map(httpsUrl), size: file.fileSize, ...file.hashes })
  }
  const overrides = new AdmZip()
  // Common overrides first; the server-specific tree wins on collisions.
  for (const prefix of ['overrides/', 'server-overrides/']) {
    for (const entry of zip.getEntries()) {
      if (!entry.isDirectory && entry.entryName.startsWith(prefix)) {
        const path = safePackPath(entry.entryName.slice(prefix.length))
        overrides.addFile(path, entry.getData())
      }
    }
  }
  return {
    mcVersion: index.dependencies.minecraft,
    loader: selected ? loaders[selected[0]] : 'vanilla',
    loaderVersion: selected ? loaderVersion(selected[1]) : undefined,
    files,
    overrides
  }
}

export function curseManifest(zip: AdmZip): { mcVersion: string; loader: LoaderType; loaderVersion?: string } {
  validateArchive(zip)
  const manifest = readJson<{ minecraft: { version: string; modLoaders: { id: string; primary?: boolean }[] } }>(zip, 'manifest.json')
  const entries = manifest.minecraft?.modLoaders
  if (!manifest.minecraft?.version || !Array.isArray(entries)) throw new Error('The CurseForge pack has no Minecraft version or loader metadata.')
  const selected = entries.find((entry) => entry.primary) ?? entries[0]
  if (!selected) return { mcVersion: manifest.minecraft.version, loader: 'vanilla' }
  const match = selected.id.match(/^(forge|neoforge|fabric|quilt)-(.+)$/)
  if (!match) throw new Error('The CurseForge pack uses an unsupported loader.')
  return { mcVersion: manifest.minecraft.version, loader: match[1] as LoaderType, loaderVersion: loaderVersion(match[2]) }
}

/** Flatten a single wrapper folder in CurseForge server distributions. */
export function serverPackOverrides(zip: AdmZip): AdmZip {
  validateArchive(zip)
  const files = zip.getEntries().filter((entry) => !entry.isDirectory)
  const roots = new Set(files.map((entry) => entry.entryName.split('/')[0]))
  const knownRoot = new Set(['mods', 'config', 'libraries', 'defaultconfigs', 'kubejs', 'scripts', 'world', 'overrides'])
  const first = files[0]?.entryName.split('/')[0]
  const prefix = roots.size === 1 && first && !knownRoot.has(first) && files.every((entry) => entry.entryName.includes('/')) ? first + '/' : ''
  const out = new AdmZip()
  for (const entry of files) {
    let path = entry.entryName.slice(prefix.length)
    if (path.startsWith('overrides/')) path = path.slice('overrides/'.length)
    out.addFile(safePackPath(path), entry.getData())
  }
  return out
}

export async function resolveLoader(plan: DeploymentPlan): Promise<RemoteDownload | undefined> {
  const { loader, loaderVersion: version, mcVersion } = plan.deployment
  if (loader === 'vanilla') return undefined
  if (!version) throw new Error('The pack did not specify a loader version.')
  if (loader === 'forge' || loader === 'neoforge') {
    return { path: '.openforge-installer.jar', urls: [installerUrl(loader, mcVersion, version)] }
  }
  if (loader === 'fabric') {
    const installers = await getJson<{ version: string; stable: boolean }[]>('https://meta.fabricmc.net/v2/versions/installer')
    const installer = installers.find((entry) => entry.stable) ?? installers[0]
    if (!installer) throw new Error('No Fabric installer is available.')
    return {
      path: '.openforge-installer.jar',
      urls: ['https://maven.fabricmc.net/net/fabricmc/fabric-installer/' + loaderVersion(installer.version) + '/fabric-installer-' + installer.version + '.jar']
    }
  }
  const xml = await getText('https://maven.quiltmc.org/repository/release/org/quiltmc/quilt-installer/maven-metadata.xml')
  const installer = xml.match(/<release>([^<]+)<\/release>/)?.[1]
  if (!installer) throw new Error('No Quilt installer is available.')
  return {
    path: '.openforge-installer.jar',
    urls: ['https://maven.quiltmc.org/repository/release/org/quiltmc/quilt-installer/' + loaderVersion(installer) + '/quilt-installer-' + installer + '.jar']
  }
}

export async function prepareDeployment(input: DeployRemoteServerInput, deps: {
  cf: CfClient
  tempDir: string
  signal?: AbortSignal
  report: (message: string) => void
}): Promise<{ plan: DeploymentPlan; archive: Buffer }> {
  validateDeployInput(input)
  deps.signal?.throwIfAborted()
  let pack: { mcVersion: string; loader: LoaderType; loaderVersion?: string; files?: RemoteDownload[]; overrides?: AdmZip } = {
    mcVersion: input.mcVersion ?? '', loader: 'vanilla'
  }
  const mr = new ModrinthClient()
  const downloadArchive = async (version: ContentVersion, cf = false): Promise<AdmZip> => {
    deps.signal?.throwIfAborted()
    const url = cf ? await deps.cf.resolveDownloadUrl(version.projectId, version) : version.downloadUrl
    if (!url) throw new Error('This pack cannot be downloaded automatically.')
    const dest = join(deps.tempDir, (cf ? 'cf' : 'mr') + '-' + (version.isServerPack ? 'server' : 'client') + '.zip')
    await downloadFile({ url: httpsUrl(url), dest, sha1: version.sha1, sha512: version.sha512, size: version.fileSize, mirrors: version.mirrors?.map(httpsUrl), signal: deps.signal })
    deps.signal?.throwIfAborted()
    return new AdmZip(dest)
  }
  if (input.source !== 'vanilla') {
    if (!input.projectId || !input.versionId) throw new Error('Choose a modpack and a version.')
    const project = input.source === 'modrinth' ? await mr.getProject(input.projectId) : await deps.cf.getProject(input.projectId)
    if (project.kind !== 'modpack') throw new Error('Choose a modpack project.')
    const version = input.source === 'modrinth' ? await mr.getVersion(input.versionId) : await deps.cf.getVersion(input.projectId, input.versionId)
    if (!version || version.projectId !== project.id) throw new Error('That version does not belong to this modpack.')
    deps.report('Downloading the pack metadata')
    if (input.source === 'modrinth') {
      pack = mrpackPlan(await downloadArchive(version))
    } else {
      if (!version.serverPackFileId || version.isServerPack) {
        throw new Error('This CurseForge release has no linked server pack. Choose a release with server files; client packs cannot safely become dedicated servers automatically.')
      }
      const metadata = curseManifest(await downloadArchive(version, true))
      const server = await deps.cf.getVersion(project.id, version.serverPackFileId)
      if (!server || server.projectId !== project.id || !server.isServerPack) throw new Error('The linked CurseForge server pack was not found.')
      deps.report('Downloading the CurseForge server files')
      pack = { ...metadata, overrides: serverPackOverrides(await downloadArchive(server, true)) }
    }
  }
  deps.signal?.throwIfAborted()
  const manifest = await fetchVersionManifest()
  const summary = manifest.versions.find((entry) => entry.id === pack.mcVersion)
  if (!summary) throw new Error('The pack specifies an unknown Minecraft version.')
  const detail = await fetchVersionDetail(summary.url)
  const vanilla = detail.downloads?.server
  if (!vanilla) throw new Error('Mojang does not publish a dedicated server for this Minecraft version.')
  const deployment: RemoteServerDeployment = {
    slug: input.slug, source: input.source, mcVersion: pack.mcVersion, loader: pack.loader,
    loaderVersion: pack.loaderVersion,
    projectId: input.source === 'vanilla' ? undefined : input.projectId,
    versionId: input.source === 'vanilla' ? undefined : input.versionId,
    ramMb: input.ramMb, gamePort: input.gamePort, javaMajor: detail.javaVersion?.majorVersion ?? 8
  }
  const plan: DeploymentPlan = {
    schema: 1, name: input.name.trim(), deployment,
    files: [{ path: 'server.jar', urls: [httpsUrl(vanilla.url)], sha1: vanilla.sha1, size: vanilla.size }, ...(pack.files ?? [])]
  }
  plan.loader = await resolveLoader(plan)
  deps.signal?.throwIfAborted()
  return { plan, archive: (pack.overrides ?? new AdmZip()).toBuffer() }
}
