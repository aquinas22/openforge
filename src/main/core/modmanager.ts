import AdmZip from 'adm-zip'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { CfFile, Instance, ModInstallResult } from '@shared/types'
import { CfClient } from './curseforge'
import { downloadFile } from './http'

interface ManagedMod {
  projectId: number
  fileId: number
  fileName: string
  name: string
  version: string
}

interface ManagedIndex {
  mods: ManagedMod[]
}

const INDEX_NAME = '.openforge-mods.json'
const LEGACY_INDEX_NAME = '.arsfodina-mods.json'

async function readIndex(instanceDir: string): Promise<ManagedIndex> {
  try {
    const indexPath = existsSync(join(instanceDir, INDEX_NAME)) ? INDEX_NAME : LEGACY_INDEX_NAME
    return JSON.parse(await readFile(join(instanceDir, indexPath), 'utf8')) as ManagedIndex
  } catch {
    return { mods: [] }
  }
}

async function saveIndex(instanceDir: string, index: ManagedIndex): Promise<void> {
  await writeFile(join(instanceDir, INDEX_NAME), JSON.stringify(index, null, 2))
}

function loaderMatches(file: CfFile, loader: Instance['loader']): boolean {
  if (loader === 'vanilla') return true
  const wanted = loader === 'neoforge' ? /neo\s*forge/i : new RegExp(loader, 'i')
  return file.loaders.length === 0 || file.loaders.some((name) => wanted.test(name))
}

function compatibleFile(files: CfFile[], instance: Instance): CfFile | null {
  return (
    files.find(
      (file) =>
        !file.isServerPack &&
        file.gameVersions.includes(instance.mcVersion) &&
        loaderMatches(file, instance.loader)
    ) ?? null
  )
}

export async function managedMods(instanceDir: string): Promise<ManagedMod[]> {
  return (await readIndex(instanceDir)).mods
}

export async function forgetManagedMod(instanceDir: string, fileName: string): Promise<void> {
  const index = await readIndex(instanceDir)
  index.mods = index.mods.filter((mod) => mod.fileName !== fileName && `${mod.fileName}.disabled` !== fileName)
  await saveIndex(instanceDir, index)
}

export async function installCurseForgeMod(opts: {
  cf: CfClient
  instance: Instance
  instanceDir: string
  projectId: number
}): Promise<ModInstallResult> {
  const { cf, instance, instanceDir } = opts
  const index = await readIndex(instanceDir)
  const installed: string[] = []
  const dependencies: string[] = []
  const visiting = new Set<number>()
  const modsDir = join(instanceDir, 'mods')
  await mkdir(modsDir, { recursive: true })

  const installProject = async (projectId: number, dependency: boolean): Promise<void> => {
    if (visiting.has(projectId)) return
    visiting.add(projectId)
    const [project, files] = await Promise.all([cf.getMod(projectId), cf.getFiles(projectId, 0, 50)])
    const file = compatibleFile(files, instance)
    if (!file) {
      throw new Error(`${project.name} has no ${instance.mcVersion} ${instance.loader} client file.`)
    }

    // relationType 3 is CurseForge's required dependency relation.
    for (const dep of file.dependencies.filter((item) => item.relationType === 3)) {
      await installProject(dep.modId, true)
    }

    const previous = index.mods.find((mod) => mod.projectId === projectId)
    const target = join(modsDir, file.fileName)
    if (previous && previous.fileName !== file.fileName) {
      const oldPath = join(modsDir, previous.fileName)
      if (existsSync(oldPath)) await rename(oldPath, `${oldPath}.old`)
    }
    const url = await cf.resolveDownloadUrl(projectId, file)
    await downloadFile({ url, dest: target, size: file.fileLength })
    const record: ManagedMod = {
      projectId,
      fileId: file.id,
      fileName: file.fileName,
      name: project.name,
      version: file.displayName
    }
    index.mods = [...index.mods.filter((mod) => mod.projectId !== projectId), record]
    ;(dependency ? dependencies : installed).push(project.name)
  }

  await installProject(opts.projectId, false)
  await saveIndex(instanceDir, index)
  return { mods: [], installed, dependencies }
}

export async function updateManagedMods(opts: {
  cf: CfClient
  instance: Instance
  instanceDir: string
}): Promise<ModInstallResult> {
  const before = await readIndex(opts.instanceDir)
  const installed: string[] = []
  const dependencies: string[] = []
  for (const mod of [...before.mods]) {
    const files = await opts.cf.getFiles(mod.projectId, 0, 50)
    const latest = compatibleFile(files, opts.instance)
    if (latest && latest.id !== mod.fileId) {
      const result = await installCurseForgeMod({ ...opts, projectId: mod.projectId })
      installed.push(...result.installed)
      dependencies.push(...result.dependencies)
    }
  }
  return { mods: [], installed, dependencies }
}

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
  const manifest = {
    minecraft: {
      version: opts.instance.mcVersion,
      modLoaders: loaderId ? [{ id: loaderId, primary: true }] : []
    },
    manifestType: 'minecraftModpack',
    manifestVersion: 1,
    name: opts.instance.name,
    version: '1.0.0',
    author: 'Openforge',
    files: index.mods.map((mod) => ({ projectID: mod.projectId, fileID: mod.fileId, required: true })),
    overrides: 'overrides'
  }
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)))
  for (const folder of ['config', 'defaultconfigs', 'kubejs', 'resourcepacks', 'shaderpacks']) {
    const source = join(opts.instanceDir, folder)
    if (existsSync(source)) zip.addLocalFolder(source, `overrides/${folder}`)
  }
  // Preserve manually imported mods; tracked CurseForge files are represented
  // by project/file IDs and are intentionally not duplicated in overrides.
  const tracked = new Set(index.mods.map((mod) => mod.fileName))
  const modsDir = join(opts.instanceDir, 'mods')
  if (existsSync(modsDir)) {
    zip.addLocalFolder(modsDir, 'overrides/mods', (path) => {
      const name = basename(path).replace(/\.disabled$/i, '')
      return !tracked.has(name) && !path.endsWith('.old')
    })
  }
  await zip.writeZipPromise(opts.destination, { overwrite: true })
}
