import AdmZip from 'adm-zip'
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { LoaderType } from '@shared/types'
import { GamePaths } from './paths'
import { DownloadTask, downloadAll, downloadFile, getJson, getText } from './http'
import { libraryArtifactTask, libraryPath, resolveVersion, type Reporter, type VerifyMode } from './installer'
import type { Library, VersionDetail } from './manifest'
import { mavenToPath } from './rules'
import { readStamp, sha1File, stampHashesMatch, stampIsFresh, stampKey, writeStamp } from './stamp'

export interface LoaderVersion {
  version: string
  stable: boolean
}

const FORGE_MAVEN = 'https://maven.minecraftforge.net/net/minecraftforge/forge'
const NEO_MAVEN = 'https://maven.neoforged.net/releases/net/neoforged'

/**
 * Build the installer URL for a Forge or NeoForge build.
 *
 * Forge:            net/minecraftforge/forge/<mc>-<ver>/forge-<mc>-<ver>-installer.jar
 * NeoForge (1.20.1): net/neoforged/forge/1.20.1-<ver>/forge-1.20.1-<ver>-installer.jar
 * NeoForge (1.20.2+): net/neoforged/neoforge/<ver>/neoforge-<ver>-installer.jar
 */
export function installerUrl(loader: LoaderType, mcVersion: string, version: string): string {
  if (loader === 'neoforge') {
    // NeoForge dropped the mc-prefixed scheme after 1.20.1.
    if (mcVersion === '1.20.1' || version.startsWith('1.20.1-')) {
      const full = version.startsWith('1.20.1-') ? version : `1.20.1-${version}`
      return `${NEO_MAVEN}/forge/${full}/forge-${full}-installer.jar`
    }
    return `${NEO_MAVEN}/neoforge/${version}/neoforge-${version}-installer.jar`
  }
  const full = version.startsWith(`${mcVersion}-`) ? version : `${mcVersion}-${version}`
  return `${FORGE_MAVEN}/${full}/forge-${full}-installer.jar`
}

function compareDesc(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((n) => parseInt(n, 10) || 0)
  const pb = b.split(/[.-]/).map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pb[i] ?? 0) !== (pa[i] ?? 0)) return (pb[i] ?? 0) - (pa[i] ?? 0)
  }
  return 0
}

/** Recommended + latest Forge builds for a Minecraft version. */
export async function getForgeVersions(mcVersion: string): Promise<LoaderVersion[]> {
  const data = await getJson<{ promos: Record<string, string> }>(
    'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json'
  )
  const recommended = data.promos[`${mcVersion}-recommended`]
  const latest = data.promos[`${mcVersion}-latest`]
  const out: LoaderVersion[] = []
  if (recommended) out.push({ version: recommended, stable: true })
  if (latest && latest !== recommended) out.push({ version: latest, stable: false })
  return out
}

/** NeoForge builds matching a Minecraft version (version scheme encodes the MC). */
export async function getNeoForgeVersions(mcVersion: string): Promise<LoaderVersion[]> {
  if (mcVersion === '1.20.1') {
    const xml = await getText('https://maven.neoforged.net/releases/net/neoforged/forge/maven-metadata.xml')
    const versions = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1])
    return versions
      .filter((v) => v.startsWith('1.20.1-'))
      .sort(compareDesc)
      .slice(0, 40)
      .map((version, i) => ({ version, stable: i === 0 }))
  }
  const parts = mcVersion.split('.')
  const prefix = `${parts[1]}.${parts[2] ?? '0'}.`
  const xml = await getText('https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml')
  const versions = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1])
  const matching = versions.filter((v) => v.startsWith(prefix) && !/beta/i.test(v)).sort(compareDesc)
  const list = (matching.length ? matching : versions.filter((v) => v.startsWith(prefix)).sort(compareDesc)).slice(0, 40)
  return list.map((version, i) => ({ version, stable: i === 0 }))
}

/** The installer refuses to run without a launcher_profiles.json in the target. */
function ensureLauncherProfiles(root: string): void {
  const p = join(root, 'launcher_profiles.json')
  if (!existsSync(p)) {
    writeFileSync(p, JSON.stringify({ profiles: {}, version: 3, settings: {} }, null, 2))
  }
}

// -- Installer metadata ---------------------------------------------------------

interface Processor {
  sides?: string[]
  jar: string
  classpath?: string[]
  args?: string[]
  outputs?: Record<string, string>
}

/** The modern (1.13+) install_profile.json, only the fields we read. */
export interface InstallProfile {
  spec?: number
  minecraft?: string
  json?: string
  data?: Record<string, { client?: string; server?: string }>
  processors?: Processor[]
  libraries?: Library[]
}

export interface InstallerMeta {
  versionId: string | null
  profile: InstallProfile | null
  versionJson: VersionDetail | null
}

/** Read what the installer is going to do without running it. */
export function readInstallerMeta(installerJar: string): InstallerMeta {
  try {
    const zip = new AdmZip(installerJar)
    const read = <T>(name: string): T | null => {
      const entry = zip.getEntry(name)
      return entry ? (JSON.parse(zip.readAsText(entry)) as T) : null
    }
    const profile = read<InstallProfile & { versionInfo?: VersionDetail }>('install_profile.json')
    const jsonName = profile?.json?.replace(/^\//, '') ?? 'version.json'
    // Legacy (1.12-era) installers carry the version under install_profile.versionInfo.
    const versionJson = read<VersionDetail>(jsonName) ?? profile?.versionInfo ?? null
    return { versionId: versionJson?.id ?? null, profile, versionJson }
  } catch {
    return { versionId: null, profile: null, versionJson: null }
  }
}

/**
 * Resolve an install_profile value the way the installer does:
 *   [group:artifact:version:classifier@ext]  -> a path under libraries/
 *   {NAME}                                   -> data[NAME].client, recursively
 *   'literal'                                -> the literal (hashes are quoted)
 */
export function resolveProfileValue(
  value: string,
  data: InstallProfile['data'],
  ctx: { libraries: string; minecraftJar: string; root: string },
  depth = 0
): string | null {
  if (depth > 8) return null
  if (value.startsWith('[') && value.endsWith(']')) {
    return join(ctx.libraries, mavenToPath(value.slice(1, -1)))
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1)
  const token = value.match(/^\{(\w+)\}$/)
  if (token) {
    const name = token[1]
    if (name === 'MINECRAFT_JAR') return ctx.minecraftJar
    if (name === 'ROOT') return ctx.root
    if (name === 'SIDE') return 'client'
    const entry = data?.[name]?.client
    return entry === undefined ? null : resolveProfileValue(entry, data, ctx, depth + 1)
  }
  return value
}

/**
 * Files the installer's client-side processors produce, with the sha1 each is
 * declared to have (when the profile says). These are the expensive outputs:
 * the patched client jar, the remapped jars, the extracted data.
 */
export function processorOutputs(
  profile: InstallProfile,
  ctx: { libraries: string; minecraftJar: string; root: string }
): { path: string; sha1?: string }[] {
  const out = new Map<string, string | undefined>()
  for (const processor of profile.processors ?? []) {
    if (processor.sides && !processor.sides.includes('client')) continue
    for (const [rawKey, rawValue] of Object.entries(processor.outputs ?? {})) {
      const path = resolveProfileValue(rawKey, profile.data, ctx)
      if (!path) continue
      const sha = resolveProfileValue(rawValue, profile.data, ctx) ?? undefined
      out.set(path, sha && /^[0-9a-f]{40}$/i.test(sha) ? sha.toLowerCase() : undefined)
    }
  }
  return [...out.entries()].map(([path, sha1]) => ({ path, sha1 }))
}

/** Downloadable libraries the installer would otherwise fetch one at a time. */
function prefetchTasks(paths: GamePaths, meta: InstallerMeta, trustExisting: boolean): DownloadTask[] {
  const tasks: DownloadTask[] = []
  const seen = new Set<string>()
  for (const lib of [...(meta.profile?.libraries ?? []), ...(meta.versionJson?.libraries ?? [])]) {
    const task = libraryArtifactTask(paths, lib)
    if (!task || seen.has(task.dest)) continue
    seen.add(task.dest)
    tasks.push({ ...task, trustExisting })
  }
  return tasks
}

const LOADER_STAMP = '.openforge-loader.json'

async function runInstaller(opts: {
  javaPath: string
  jar: string
  root: string
  label: string
  report: Reporter
  onLog?: (line: string) => void
}): Promise<void> {
  const { javaPath, jar, root, label, report, onLog } = opts
  const started = Date.now()
  await new Promise<void>((resolve, reject) => {
    const child = spawn(javaPath, ['-Djava.awt.headless=true', '-jar', jar, '--installClient', root], {
      cwd: root,
      windowsHide: true
    })
    let processorStep = 0
    const onData = (buf: Buffer): void => {
      for (const line of buf.toString('utf8').split(/\r?\n/)) {
        if (!line.trim()) continue
        onLog?.(line)
        // The installer announces each processor; count them for a steadier label.
        if (/^\s*(?:Processor|Task|MainClass):/i.test(line)) processorStep++
        const elapsed = Math.round((Date.now() - started) / 1000)
        report(
          'loader',
          processorStep ? `Patching ${label} (step ${processorStep})` : `Installing ${label}`,
          -1,
          `${elapsed}s · ${line.trim().slice(0, 80)}`
        )
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              `${label} installer exited with code ${code}. Open the console for its log, then try Verify and repair files.`
            )
          )
    )
  })
}

/**
 * Provision a Forge/NeoForge client.
 *
 * The official installer is the only thing that knows how to run the patch
 * processors, but it is slow: it downloads every library serially and
 * re-runs processors on every invocation. So:
 *  1. The installer jar is cached, and a stamp records the processor outputs
 *     (patched client, remapped jars) with their hashes. When the stamp still
 *     matches the disk, the installer is skipped entirely - a second profile on
 *     the same NeoForge build, or a pack update that keeps its loader, costs a
 *     few stat calls.
 *  2. Before the installer runs, its libraries and the vanilla client jar are
 *     fetched in parallel. The installer finds them present with the right
 *     hash and skips straight to the processors.
 *
 * Returns the created version id, which the standard installer then resolves
 * (it inheritsFrom the vanilla version) to finish assets/natives.
 */
export async function installForgeLike(opts: {
  paths: GamePaths
  loader: LoaderType
  mcVersion: string
  version: string
  javaPath: string
  report: Reporter
  onLog?: (line: string) => void
  concurrency?: number
  mode?: VerifyMode
}): Promise<string> {
  const { paths, loader, mcVersion, version, javaPath, report, onLog } = opts
  const mode = opts.mode ?? 'quick'
  const concurrency = opts.concurrency ?? 16
  const label = loader === 'neoforge' ? 'NeoForge' : 'Forge'

  const url = installerUrl(loader, mcVersion, version)
  const installersDir = join(paths.root, 'installers')
  await mkdir(installersDir, { recursive: true })
  const jar = join(installersDir, url.split('/').pop()!)

  report('loader', `Checking ${label} ${version}`, -1)
  await downloadFile({ url, dest: jar })

  const meta = readInstallerMeta(jar)
  const installerSha = await sha1File(jar)
  const key = stampKey(['loader', 1, installerSha, meta.versionId ?? ''])
  const ctx = {
    libraries: paths.libraries,
    minecraftJar: paths.versionJar(meta.profile?.minecraft ?? mcVersion),
    root: paths.root
  }

  // Warm path: everything the installer produced is still here, unchanged.
  if (meta.versionId && existsSync(paths.versionJson(meta.versionId))) {
    const stampPath = join(paths.versionDir(meta.versionId), LOADER_STAMP)
    const stamp = await readStamp(stampPath)
    const fresh = stampIsFresh(stamp, key)
    if (fresh.fresh && (mode === 'quick' || (stamp && (await stampHashesMatch(stamp))))) {
      onLog?.(`[Openforge] ${label} ${version} already installed - reusing the patched client.`)
      report('loader', `${label} ready`, 1, 'Reusing the patched client from a previous install')
      return meta.versionId
    }
    if (stamp) onLog?.(`[Openforge] ${label} install cache is stale (${fresh.reason ?? 'hash mismatch'}); re-running installer.`)
  }

  // Parallel prefetch of everything the installer would download serially.
  report('loader', `Fetching ${label} libraries`, 0)
  const vanillaClient = (async () => {
    const vanilla = await resolveVersion(paths, meta.profile?.minecraft ?? mcVersion)
    const client = vanilla.downloads?.client
    if (client?.url) {
      await downloadFile({
        url: client.url,
        dest: paths.versionJar(vanilla.id),
        sha1: client.sha1,
        size: client.size,
        trustExisting: mode === 'quick'
      })
    }
  })()
  const libraries = downloadAll(prefetchTasks(paths, meta, mode === 'quick'), concurrency, (done, total) =>
    report('loader', `Fetching ${label} libraries`, total ? done / total : 1, `${done}/${total}`)
  )
  await Promise.all([vanillaClient, libraries])

  ensureLauncherProfiles(paths.root)
  await mkdir(paths.versions, { recursive: true })
  const before = new Set(readdirSync(paths.versions))

  report('loader', `Installing ${label}`, -1, 'Patching Minecraft - this runs once per loader version')
  const started = Date.now()
  await runInstaller({ javaPath, jar, root: paths.root, label, report, onLog })
  onLog?.(`[Openforge] ${label} installer finished in ${Math.round((Date.now() - started) / 1000)}s.`)

  // Prefer the id declared by the installer; fall back to the newly created dir.
  let versionId: string | undefined
  if (meta.versionId && existsSync(paths.versionJson(meta.versionId))) versionId = meta.versionId
  else {
    const created = readdirSync(paths.versions).filter((d) => !before.has(d))
    versionId = created.find((d) => /forge/i.test(d)) ?? created.find((d) => d !== mcVersion) ?? created[0]
  }
  if (!versionId || !existsSync(paths.versionJson(versionId))) {
    throw new Error(`${label} installer finished but no version profile was created.`)
  }

  // Record what the processors produced, checking declared hashes as we go.
  const outputs = meta.profile ? processorOutputs(meta.profile, ctx) : []
  for (const output of outputs) {
    if (!existsSync(output.path)) {
      throw new Error(`${label} installer did not produce ${output.path}. Try Verify and repair files.`)
    }
    if (output.sha1 && (await sha1File(output.path)) !== output.sha1) {
      throw new Error(`${label} produced a corrupt file (${output.path}). Try Verify and repair files.`)
    }
  }
  const versionLibs = (meta.versionJson?.libraries ?? []).map((lib) => libraryPath(paths, lib))
  await writeStamp(
    join(paths.versionDir(versionId), LOADER_STAMP),
    key,
    [paths.versionJson(versionId), ...outputs.map((o) => o.path), ...versionLibs],
    { hash: true, meta: { installer: url, loader, version } }
  )
  return versionId
}
