import AdmZip from 'adm-zip'
import { existsSync, statSync } from 'node:fs'
import { copyFile, link, mkdir, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { ProgressEvent } from '@shared/types'
import { GamePaths } from './paths'
import {
  AssetIndex,
  Library,
  RESOURCES_BASE,
  VersionDetail,
  fetchVersionDetail,
  fetchVersionManifest
} from './manifest'
import { DownloadTask, downloadAll, downloadFile } from './http'
import { isAllowed, mavenToPath, nativeClassifier } from './rules'
import { readStamp, stampIsFresh, stampKey, writeStamp } from './stamp'

export type Reporter = (
  phase: ProgressEvent['phase'],
  label: string,
  progress: number,
  detail?: string
) => void

/**
 * How hard an install checks files that are already on disk.
 *  - quick: trust a present file of the right size (everything we write lands
 *           through a verified rename, so this is safe for normal installs)
 *  - full:  re-hash everything. Used by "Verify and repair files".
 */
export type VerifyMode = 'quick' | 'full'

/**
 * Ensure a version JSON exists locally, downloading it from the Mojang manifest
 * if this is a vanilla id we've never seen. Modded versions (Fabric/Forge) are
 * written to disk by their loader installer before we get here.
 */
async function ensureVersionJson(paths: GamePaths, versionId: string): Promise<VersionDetail> {
  const jsonPath = paths.versionJson(versionId)
  if (existsSync(jsonPath)) {
    return JSON.parse(await readFile(jsonPath, 'utf8')) as VersionDetail
  }
  const manifest = await fetchVersionManifest()
  const entry = manifest.versions.find((v) => v.id === versionId)
  if (!entry) throw new Error(`Unknown Minecraft version "${versionId}"`)
  const detail = await fetchVersionDetail(entry.url)
  await mkdir(paths.versionDir(versionId), { recursive: true })
  await writeFile(jsonPath, JSON.stringify(detail, null, 2))
  return detail
}

/** Merge a modloader profile with the vanilla version it inherits from. */
export function mergeVersions(child: VersionDetail, parent: VersionDetail): VersionDetail {
  const seen = new Set<string>()
  const libraries: Library[] = []
  for (const lib of [...child.libraries, ...parent.libraries]) {
    // Dedupe by group:artifact, keeping the loader's version (it comes first).
    const key = lib.name.split(':').slice(0, 2).join(':')
    const native = nativeClassifier(lib)
    if (seen.has(key)) {
      // Loader profiles sometimes replace an LWJGL classpath artifact while
      // omitting the parent's native classifier metadata. Keep a native-only
      // copy of that parent entry or the game starts with no lwjgl natives.
      if (lib.natives && lib.downloads?.classifiers) {
        libraries.push({
          ...lib,
          downloads: { classifiers: lib.downloads.classifiers }
        })
      } else if (native) libraries.push(lib)
      continue
    }
    // Native-coordinate entries share group:artifact with the Java artifact,
    // but are a distinct required file and must not consume its dedupe key.
    if (!native) seen.add(key)
    libraries.push(lib)
  }
  // Only produce the modern `arguments` block when one side actually has it.
  // An empty block would make the launcher think a legacy (1.12-era) profile is
  // modern and start the game without a classpath or natives path.
  const hasModernArgs = Boolean(child.arguments || parent.arguments)
  return {
    ...parent,
    ...child,
    id: child.id,
    mainClass: child.mainClass || parent.mainClass,
    assets: parent.assets,
    assetIndex: parent.assetIndex,
    downloads: parent.downloads,
    javaVersion: parent.javaVersion || child.javaVersion,
    libraries,
    minecraftArguments: child.minecraftArguments || parent.minecraftArguments,
    arguments: hasModernArgs
      ? {
          game: [...(parent.arguments?.game ?? []), ...(child.arguments?.game ?? [])],
          jvm: [...(parent.arguments?.jvm ?? []), ...(child.arguments?.jvm ?? [])]
        }
      : undefined
  }
}

/** Recursively resolve a version (following inheritsFrom) into one flat detail. */
export async function resolveVersion(paths: GamePaths, versionId: string): Promise<VersionDetail> {
  const detail = await ensureVersionJson(paths, versionId)
  if (!detail.inheritsFrom) return detail
  const parent = await resolveVersion(paths, detail.inheritsFrom)
  return mergeVersions(detail, parent)
}

/** Libraries that apply on this OS, split into normal classpath libs + natives. */
export function selectLibraries(version: VersionDetail): { classpath: Library[]; natives: Library[] } {
  const classpath: Library[] = []
  const natives: Library[] = []
  for (const lib of version.libraries) {
    if (!isAllowed(lib.rules)) continue
    const native = nativeClassifier(lib)
    if (native) natives.push(lib)
    if (!native && (lib.downloads?.artifact || lib.url || (!lib.natives && !lib.downloads?.classifiers))) {
      classpath.push(lib)
    }
  }
  return { classpath, natives }
}

export function libraryArtifactTask(paths: GamePaths, lib: Library): DownloadTask | null {
  const artifact = lib.downloads?.artifact
  if (artifact?.url) {
    const rel = artifact.path ?? mavenToPath(lib.name)
    return { url: artifact.url, dest: paths.library(rel), sha1: artifact.sha1, size: artifact.size }
  }
  // Maven-style library (Fabric): build url from base + coordinate path.
  if (lib.url) {
    const rel = mavenToPath(lib.name)
    const base = lib.url.endsWith('/') ? lib.url : lib.url + '/'
    return { url: base + rel, dest: paths.library(rel) }
  }
  return null
}

/** Where a classpath library lives on disk, whether or not it is downloadable. */
export function libraryPath(paths: GamePaths, lib: Library): string {
  return paths.library(lib.downloads?.artifact?.path ?? mavenToPath(lib.name))
}

function nativeArtifactTask(paths: GamePaths, lib: Library): DownloadTask | null {
  const classifier = nativeClassifier(lib)
  if (!classifier) return null
  const coordinateClassifier = lib.name.split(':')[3]
  const artifact =
    coordinateClassifier === classifier
      ? lib.downloads?.artifact
      : lib.downloads?.classifiers?.[classifier]
  if (!artifact?.url) return null
  const rel = artifact.path ?? mavenToPath(`${lib.name}:${classifier}`)
  return { url: artifact.url, dest: paths.library(rel), sha1: artifact.sha1, size: artifact.size }
}

async function extractNatives(paths: GamePaths, version: VersionDetail, natives: Library[]): Promise<void> {
  const dir = paths.nativesDir(version.id)
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  for (const lib of natives) {
    const task = nativeArtifactTask(paths, lib)
    if (!task || !existsSync(task.dest)) continue
    const exclude = lib.extract?.exclude ?? ['META-INF/']
    const zip = new AdmZip(task.dest)
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) continue
      const name = entry.entryName
      if (exclude.some((ex) => name.startsWith(ex))) continue
      if (name.startsWith('META-INF/')) continue
      zip.extractEntryTo(entry, dir, false, true, false, basename(name))
    }
  }
}

const NATIVES_STAMP = '.openforge-natives.json'

/**
 * Make sure this version's LWJGL natives are unpacked. A stamp inside the
 * natives folder records which jars produced it, so a warm launch costs a few
 * stat calls instead of re-hashing and re-extracting every native jar.
 */
export async function prepareNatives(
  paths: GamePaths,
  version: VersionDetail,
  mode: VerifyMode = 'quick'
): Promise<number> {
  const { natives } = selectLibraries(version)
  const tasks: DownloadTask[] = []
  for (const lib of natives) {
    const task = nativeArtifactTask(paths, lib)
    if (!task) {
      throw new Error(`No ${nativeClassifier(lib)} download was declared for ${lib.name}.`)
    }
    tasks.push({ ...task, trustExisting: mode === 'quick' })
  }

  const dir = paths.nativesDir(version.id)
  const stampPath = join(dir, NATIVES_STAMP)
  const key = stampKey(['natives', process.platform, process.arch, ...tasks.map((t) => `${t.dest}#${t.sha1 ?? ''}`)])
  if (mode === 'quick') {
    const stamp = await readStamp(stampPath)
    if (stampIsFresh(stamp, key).fresh) return Number(stamp?.meta?.loadable ?? '0')
  }

  await downloadAll(tasks, 8)
  await extractNatives(paths, version, natives)
  const files = await readdir(dir)
  const loadable = files.filter((name) => /\.(?:dll|so|dylib|jnilib)$/i.test(name))
  if (natives.length > 0 && loadable.length === 0) {
    throw new Error(
      `LWJGL native extraction produced no loadable libraries for ${process.platform}/${process.arch}. ` +
        'Use Repair files and confirm that the pack supports this system architecture.'
    )
  }
  if (process.platform === 'win32' && natives.some((lib) => lib.name.startsWith('org.lwjgl:lwjgl:'))) {
    const lwjgl = loadable.find((name) => name.toLowerCase() === 'lwjgl.dll')
    if (!lwjgl) {
      throw new Error(
        `LWJGL native repair extracted ${loadable.length} DLLs, but lwjgl.dll is missing. ` +
          'Use Repair files to redownload the Windows LWJGL native JAR.'
      )
    }
  }
  await writeStamp(stampPath, key, [...tasks.map((t) => t.dest), ...loadable.map((name) => join(dir, name))], {
    meta: { loadable: String(loadable.length) }
  })
  return loadable.length
}

async function downloadAssets(
  paths: GamePaths,
  version: VersionDetail,
  concurrency: number,
  report: Reporter,
  mode: VerifyMode,
  resourcesBase: string
): Promise<void> {
  if (!version.assetIndex) return
  const indexPath = paths.assetIndex(version.assetIndex.id)
  await downloadFile({
    url: version.assetIndex.url,
    dest: indexPath,
    sha1: version.assetIndex.sha1,
    size: version.assetIndex.size
  })
  const index: AssetIndex = JSON.parse(await readFile(indexPath, 'utf8'))
  // Asset objects are content-addressed, so the same hash is often listed
  // under several names. Fetch each object once.
  const unique = new Map<string, { hash: string; size: number }>()
  for (const obj of Object.values(index.objects)) unique.set(obj.hash, obj)
  const tasks: DownloadTask[] = [...unique.values()].map((obj) => ({
    url: `${resourcesBase}/${obj.hash.substring(0, 2)}/${obj.hash}`,
    dest: paths.assetObject(obj.hash),
    sha1: obj.hash,
    size: obj.size,
    trustExisting: mode === 'quick'
  }))
  await downloadAll(tasks, concurrency, (done, total) =>
    report('assets', 'Downloading assets', total ? done / total : 1, `${done}/${total} files`)
  )

  // Legacy versions (<= 1.7) expect assets laid out by their virtual name.
  if (index.virtual || index.map_to_resources) {
    const virtualRoot = join(paths.assetsVirtual, version.assetIndex.id)
    for (const [name, obj] of Object.entries(index.objects)) {
      const target = join(virtualRoot, name)
      if (existsSync(target)) continue
      await mkdir(join(target, '..'), { recursive: true })
      await writeFile(target, await readFile(paths.assetObject(obj.hash)))
    }
  }
}

/**
 * The jar the launcher puts on the classpath for this version.
 *
 * The official launcher always runs `versions/<id>/<id>.jar`, copying the
 * parent's jar there for inheriting (modded) versions. Forge and NeoForge rely
 * on that name: their `-DignoreList` contains `${version_name}.jar` so the
 * module system skips the unpatched vanilla jar. Running the parent's
 * `1.20.1.jar` instead makes it load as a second copy of Minecraft.
 */
export function versionJarFor(paths: GamePaths, version: VersionDetail): string {
  return paths.versionJar(version.id)
}

/** Put the vanilla jar at the loader version's own path, hard-linking when possible. */
export async function ensureVersionJar(paths: GamePaths, version: VersionDetail): Promise<void> {
  if (!version.inheritsFrom) return
  const source = paths.versionJar(version.inheritsFrom)
  const target = paths.versionJar(version.id)
  if (!existsSync(source)) return
  const sourceSize = statSync(source).size
  if (existsSync(target)) {
    if (statSync(target).size === sourceSize) return
    await unlink(target).catch(() => undefined)
  }
  await mkdir(paths.versionDir(version.id), { recursive: true })
  try {
    await link(source, target)
  } catch {
    await copyFile(source, target)
  }
}

const READY_STAMP = '.openforge-ready.json'

function readyKey(version: VersionDetail): string {
  return stampKey(['ready', 2, process.platform, process.arch, JSON.stringify(version)])
}

/** Every file a launch of this version needs, excluding assets. */
function launchFiles(paths: GamePaths, version: VersionDetail): string[] {
  const { classpath } = selectLibraries(version)
  const files = classpath.map((lib) => libraryPath(paths, lib))
  if (version.downloads?.client) files.push(paths.versionJar(version.inheritsFrom ?? version.id))
  if (version.inheritsFrom) files.push(versionJarFor(paths, version))
  if (version.assetIndex) files.push(paths.assetIndex(version.assetIndex.id))
  return files
}

/**
 * The warm-launch check: is everything this version needs still exactly where
 * the last verified install left it? A stat per file, no network, no hashing.
 */
export async function isVersionReady(
  paths: GamePaths,
  version: VersionDetail
): Promise<{ fresh: boolean; reason?: string }> {
  const stamp = await readStamp(join(paths.versionDir(version.id), READY_STAMP))
  return stampIsFresh(stamp, readyKey(version))
}

/**
 * Full install for a resolved version: client jar, libraries, natives, assets.
 * Returns the resolved detail so the launcher can build its command line.
 */
export async function installVersion(
  paths: GamePaths,
  versionId: string,
  report: Reporter,
  concurrency = 16,
  mode: VerifyMode = 'quick',
  opts: { resourcesBase?: string } = {}
): Promise<VersionDetail> {
  report('manifest', 'Resolving version', -1, versionId)
  const version = await resolveVersion(paths, versionId)
  const trustExisting = mode === 'quick'

  // Client jar, libraries and natives go into one parallel pool rather than
  // waiting on the ~25 MB client jar before starting on the libraries.
  const tasks: DownloadTask[] = []
  const client = version.downloads?.client
  if (client?.url) {
    tasks.push({
      url: client.url,
      dest: paths.versionJar(version.inheritsFrom ?? version.id),
      sha1: client.sha1,
      size: client.size,
      trustExisting
    })
  }
  const { classpath, natives } = selectLibraries(version)
  for (const lib of classpath) {
    const t = libraryArtifactTask(paths, lib)
    if (t) tasks.push({ ...t, trustExisting })
  }
  for (const lib of natives) {
    const t = nativeArtifactTask(paths, lib)
    if (t) tasks.push({ ...t, trustExisting })
  }
  const seen = new Set<string>()
  const unique = tasks.filter((task) => (seen.has(task.dest) ? false : (seen.add(task.dest), true)))
  await downloadAll(unique, concurrency, (done, total) =>
    report('libraries', 'Downloading game files', total ? done / total : 1, `${done}/${total} libraries`)
  )
  await ensureVersionJar(paths, version)

  report('natives', 'Unpacking natives', -1)
  await prepareNatives(paths, version, mode)

  await downloadAssets(paths, version, concurrency, report, mode, opts.resourcesBase ?? RESOURCES_BASE)

  // Anything the classpath lists but no download produced (a Forge processor
  // output, say) should exist by now. Some old profiles list entries the game
  // never loads, so this is surfaced rather than fatal.
  const missing = classpath.map((lib) => libraryPath(paths, lib)).filter((file) => !existsSync(file))
  if (missing.length) {
    report(
      'libraries',
      'Some libraries are missing',
      1,
      `${missing.length} not found (first: ${basename(missing[0])}). If the game fails to start, use Verify and repair files.`
    )
  }

  await writeStamp(join(paths.versionDir(version.id), READY_STAMP), readyKey(version), launchFiles(paths, version))
  report('done', 'Install complete', 1)
  return version
}
