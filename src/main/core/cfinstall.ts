import AdmZip from 'adm-zip'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { LoaderType } from '@shared/types'
import { GamePaths } from './paths'
import { CfClient } from './curseforge'
import { downloadFile, DownloadTask, downloadAll } from './http'
import type { Reporter } from './installer'

interface CfManifest {
  minecraft: { version: string; modLoaders: { id: string; primary?: boolean }[] }
  name?: string
  version?: string
  author?: string
  files: { projectID: number; fileID: number; required?: boolean }[]
  overrides?: string
}

export interface CfInstallResult {
  mcVersion: string
  loader: LoaderType
  loaderVersion?: string
  name: string
  failedMods: number
  totalMods: number
}

/** "forge-47.2.0" / "neoforge-20.4.190" / "fabric-0.15.0" -> {type, version} */
function parseLoader(id: string): { type: LoaderType; version: string } {
  const dash = id.indexOf('-')
  const rawType = (dash >= 0 ? id.slice(0, dash) : id).toLowerCase()
  const version = dash >= 0 ? id.slice(dash + 1) : ''
  const type: LoaderType =
    rawType === 'fabric' || rawType === 'quilt'
      ? 'fabric'
      : rawType === 'neoforge'
        ? 'neoforge'
        : rawType === 'forge'
          ? 'forge'
          : 'vanilla'
  return { type, version }
}

async function downloadPackZip(cf: CfClient, projectId: number, fileId: number, report: Reporter): Promise<string> {
  report('preparing', 'Fetching pack file', -1)
  const file = await cf.resolveFile(projectId, fileId)
  if (!file) throw new Error('Could not resolve the modpack file from CurseForge.')
  const url = await cf.resolveDownloadUrl(projectId, file)
  const dest = join(tmpdir(), `openforge-pack-${projectId}-${fileId}.zip`)
  report('preparing', 'Downloading modpack', -1, file.fileName)
  await downloadFile({ url, dest })
  return dest
}

/**
 * Install a CurseForge modpack as a playable client instance:
 * pack zip -> manifest -> mod loader -> mods -> overrides.
 */
export async function installCurseForgeModpack(opts: {
  cf: CfClient
  paths: GamePaths
  instanceId: string
  projectId: number
  fileId: number
  report: Reporter
}): Promise<CfInstallResult> {
  const { cf, paths, instanceId, projectId, fileId, report } = opts
  const instanceDir = paths.instanceDir(instanceId)
  await mkdir(instanceDir, { recursive: true })

  const zipPath = await downloadPackZip(cf, projectId, fileId, report)
  const zip = new AdmZip(zipPath)
  const manifestEntry = zip.getEntry('manifest.json')
  if (!manifestEntry) throw new Error('This file is not a CurseForge modpack (no manifest.json).')
  const manifest: CfManifest = JSON.parse(zip.readAsText(manifestEntry))

  const mcVersion = manifest.minecraft.version
  const primary = manifest.minecraft.modLoaders.find((l) => l.primary) ?? manifest.minecraft.modLoaders[0]
  const loaderInfo = primary ? parseLoader(primary.id) : { type: 'vanilla' as LoaderType, version: '' }
  // The mod loader itself is installed by the orchestrator (it needs Java),
  // after this returns. Here we only fetch the pack's mods + overrides.

  // ── Mods ────────────────────────────────────────────────────────────────
  const modsDir = join(instanceDir, 'mods')
  await mkdir(modsDir, { recursive: true })
  const refs = manifest.files ?? []
  report('mods', 'Resolving mods', 0, `0/${refs.length}`)

  const tasks: DownloadTask[] = []
  const managed: {
    projectId: number
    fileId: number
    fileName: string
    name: string
    version: string
  }[] = []
  let resolved = 0
  // Resolve file metadata (name + url) with light concurrency.
  const CHUNK = 8
  for (let i = 0; i < refs.length; i += CHUNK) {
    const slice = refs.slice(i, i + CHUNK)
    const results = await Promise.all(
      slice.map(async (ref) => {
        try {
          const f = await cf.resolveFile(ref.projectID, ref.fileID)
          if (!f) return null
          const url = await cf.resolveDownloadUrl(ref.projectID, f)
          return {
            task: { url, dest: join(modsDir, f.fileName) } as DownloadTask,
            managed: {
              projectId: ref.projectID,
              fileId: ref.fileID,
              fileName: f.fileName,
              name: f.displayName,
              version: f.displayName
            }
          }
        } catch {
          return null
        }
      })
    )
    for (const result of results) {
      if (!result) continue
      tasks.push(result.task)
      managed.push(result.managed)
    }
    resolved += slice.length
    report('mods', 'Resolving mods', refs.length ? resolved / refs.length : 1, `${resolved}/${refs.length}`)
  }

  let failed = refs.length - tasks.length
  let downloaded = 0
  await downloadAll(tasks, 8, (done, total) => {
    downloaded = done
    report('mods', 'Downloading mods', total ? done / total : 1, `${done}/${total}`)
  }).catch(() => {
    failed += tasks.length - downloaded
  })

  // ── Overrides ─────────────────────────────────────────────────────────────
  report('overrides', 'Applying pack files', -1)
  const overridesRoot = manifest.overrides ?? 'overrides'
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue
    const name = entry.entryName
    for (const root of [overridesRoot, 'client-overrides']) {
      const prefix = root.endsWith('/') ? root : root + '/'
      if (name.startsWith(prefix)) {
        const rel = name.slice(prefix.length)
        const target = join(instanceDir, rel)
        await mkdir(join(target, '..'), { recursive: true })
        await writeFile(target, entry.getData())
      }
    }
  }

  await rm(zipPath, { force: true })
  await writeFile(join(instanceDir, '.openforge-mods.json'), JSON.stringify({ mods: managed }, null, 2))
  report('mods', 'Mods & files ready', 1, `${tasks.length} mods`)

  return {
    mcVersion,
    loader: loaderInfo.type,
    loaderVersion: loaderInfo.version || undefined,
    name: manifest.name ?? 'CurseForge Modpack',
    failedMods: Math.max(0, failed),
    totalMods: refs.length
  }
}
