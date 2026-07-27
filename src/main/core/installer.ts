import AdmZip from 'adm-zip'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
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

export type Reporter = (
  phase: ProgressEvent['phase'],
  label: string,
  progress: number,
  detail?: string
) => void

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
function mergeVersions(child: VersionDetail, parent: VersionDetail): VersionDetail {
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
    arguments: {
      game: [...(parent.arguments?.game ?? []), ...(child.arguments?.game ?? [])],
      jvm: [...(parent.arguments?.jvm ?? []), ...(child.arguments?.jvm ?? [])]
    }
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

function libraryArtifactTask(paths: GamePaths, lib: Library): DownloadTask | null {
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

/** Repair/download the small platform-native set before every launch. */
export async function prepareNatives(paths: GamePaths, version: VersionDetail): Promise<number> {
  const { natives } = selectLibraries(version)
  const tasks: DownloadTask[] = []
  for (const lib of natives) {
    const task = nativeArtifactTask(paths, lib)
    if (!task) {
      throw new Error(`No ${nativeClassifier(lib)} download was declared for ${lib.name}.`)
    }
    tasks.push(task)
  }
  await downloadAll(tasks, 8)
  await extractNatives(paths, version, natives)
  const files = await readdir(paths.nativesDir(version.id))
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
  return loadable.length
}

async function downloadAssets(
  paths: GamePaths,
  version: VersionDetail,
  concurrency: number,
  report: Reporter
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
  const tasks: DownloadTask[] = Object.values(index.objects).map((obj) => ({
    url: `${RESOURCES_BASE}/${obj.hash.substring(0, 2)}/${obj.hash}`,
    dest: paths.assetObject(obj.hash),
    sha1: obj.hash,
    size: obj.size
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
 * Full install for a resolved version: client jar, libraries, natives, assets.
 * Returns the resolved detail so the launcher can build its command line.
 */
export async function installVersion(
  paths: GamePaths,
  versionId: string,
  report: Reporter,
  concurrency = 16
): Promise<VersionDetail> {
  report('manifest', 'Resolving version', -1, versionId)
  const version = await resolveVersion(paths, versionId)

  // Client jar
  report('client', 'Downloading game client', -1, versionId)
  const client = version.downloads?.client
  if (client?.url) {
    await downloadFile({
      url: client.url,
      dest: paths.versionJar(version.inheritsFrom ?? version.id),
      sha1: client.sha1,
      size: client.size
    })
  }

  // Libraries + natives
  const { classpath, natives } = selectLibraries(version)
  const libTasks: DownloadTask[] = []
  for (const lib of classpath) {
    const t = libraryArtifactTask(paths, lib)
    if (t) libTasks.push(t)
  }
  for (const lib of natives) {
    const t = nativeArtifactTask(paths, lib)
    if (t) libTasks.push(t)
  }
  await downloadAll(libTasks, concurrency, (done, total) =>
    report('libraries', 'Downloading libraries', total ? done / total : 1, `${done}/${total}`)
  )

  report('natives', 'Unpacking natives', -1)
  await prepareNatives(paths, version)

  await downloadAssets(paths, version, concurrency, report)

  report('done', 'Install complete', 1)
  return version
}
