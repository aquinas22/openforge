import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { totalmem } from 'node:os'
import { copyFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { InstalledMod, Instance, LogLine, ProgressEvent } from '@shared/types'
import { IPC } from '@shared/ipc'
import type { CfInstallInput, CfSearchInput, CreateInstanceInput, LaunchResult } from '@shared/ipc'
import { GamePaths } from './core/paths'
import {
  loadInstances,
  loadSettings,
  loadUsername,
  saveInstances,
  saveSettings,
  saveUsername
} from './core/store'
import { launchAccount, makeOfflineAccount } from './core/auth'
import { discoverJava, selectJava } from './core/java'
import { fetchVersionManifest } from './core/manifest'
import { installVersion, prepareNatives, resolveVersion, Reporter } from './core/installer'
import { getFabricLoaderVersions, installFabric } from './core/fabric'
import { getForgeVersions, getNeoForgeVersions, installForgeLike } from './core/forge'
import type { LoaderType } from '@shared/types'
import { launchGame, RunningGame } from './core/launcher'
import { CfClient, MOD_CLASS, MODPACK_CLASS } from './core/curseforge'
import { installCurseForgeModpack } from './core/cfinstall'
import {
  exportCurseForgePack,
  forgetManagedMod,
  installCurseForgeMod,
  managedMods,
  updateManagedMods
} from './core/modmanager'
import { openOfficialLauncher, registerOfficialProfile } from './core/official-launcher'

export function registerIpc(getWindow: () => BrowserWindow | null): void {
  let settings = loadSettings()
  let instances = loadInstances()
  let username = loadUsername()
  const running = new Map<string, RunningGame>()
  const totalMemoryMb = Math.floor(totalmem() / 1024 / 1024)
  // Keep at least 2 GiB and 25% of physical RAM available for the OS/launcher.
  const maxRamMb = Math.max(
    1024,
    Math.floor(Math.min(totalMemoryMb - 2048, totalMemoryMb * 0.75) / 256) * 256
  )
  const clampRam = (value: number): number =>
    Math.min(maxRamMb, Math.max(1024, Math.round(value / 256) * 256))
  if (settings.ramMb !== clampRam(settings.ramMb)) {
    settings.ramMb = clampRam(settings.ramMb)
    saveSettings(settings)
  }

  const paths = (): GamePaths => new GamePaths(settings.gameDir)
  const cfClient = (): CfClient => new CfClient(settings.cfProxyUrl, settings.cfApiKey)

  const send = (channel: string, payload: unknown): void => {
    getWindow()?.webContents.send(channel, payload)
  }
  const reporterFor =
    (instanceId: string): Reporter =>
    (phase, label, progress, detail) => {
      const evt: ProgressEvent = { instanceId, phase, label, progress, detail }
      send(IPC.progressEvent, evt)
    }
  const logFor = (instanceId: string, stream: LogLine['stream'], line: string): void => {
    const evt: LogLine = { instanceId, stream, line, ts: Date.now() }
    send(IPC.logEvent, evt)
  }

  const persist = (): void => saveInstances(instances)
  const findInstance = (id: string): Instance => {
    const inst = instances.find((i) => i.id === id)
    if (!inst) throw new Error('Instance not found')
    return inst
  }
  const modsDir = (id: string): string => join(paths().instanceDir(findInstance(id).id), 'mods')
  const safeModName = (name: string): string => {
    const clean = basename(name)
    if (clean !== name || !/\.jar(?:\.disabled)?$/i.test(clean)) throw new Error('Invalid mod filename.')
    return clean
  }
  const listMods = async (id: string): Promise<InstalledMod[]> => {
    const dir = modsDir(id)
    const records = await managedMods(paths().instanceDir(id))
    await mkdir(dir, { recursive: true })
    const names = await readdir(dir)
    const mods = await Promise.all(
      names
        .filter((name) => /\.jar(?:\.disabled)?$/i.test(name))
        .map(async (fileName) => {
          const info = await stat(join(dir, fileName))
          const enabled = !fileName.toLowerCase().endsWith('.disabled')
          const jarName = enabled ? fileName : fileName.slice(0, -'.disabled'.length)
          const record = records.find((mod) => mod.fileName === jarName)
          return {
            fileName,
            displayName: record?.name ?? jarName.replace(/\.jar$/i, '').replace(/[-_]+/g, ' '),
            enabled,
            size: info.size,
            projectId: record?.projectId,
            fileId: record?.fileId,
            version: record?.version
          }
        })
    )
    return mods.sort((a, b) => a.displayName.localeCompare(b.displayName))
  }

  // ── Full install of an instance (vanilla / fabric / forge / curseforge) ────
  async function doInstall(inst: Instance): Promise<Instance> {
    const report = reporterFor(inst.id)
    const p = paths()

    // Install the mod loader (if any) and return the version id to launch.
    const installLoader = async (
      loader: Instance['loader'],
      mcVersion: string,
      loaderVersion?: string
    ): Promise<string> => {
      if (loader === 'fabric') {
        report('loader', 'Installing Fabric', -1, mcVersion)
        return installFabric(p, mcVersion, loaderVersion)
      }
      if (loader === 'forge' || loader === 'neoforge') {
        if (!loaderVersion) throw new Error(`Missing ${loader} version for ${mcVersion}.`)
        const vanilla = await resolveVersion(p, mcVersion)
        const requiredMajor = vanilla.javaVersion?.majorVersion ?? 8
        const java = await selectJava(requiredMajor, settings.javaPath)
        if (!java) {
          throw new Error(`Installing ${loader} needs a Java ${requiredMajor}+ runtime. Set one in Settings.`)
        }
        return installForgeLike({
          paths: p,
          loader,
          mcVersion,
          version: loaderVersion,
          javaPath: java.path,
          report,
          onLog: (line) => logFor(inst.id, 'system', line)
        })
      }
      return mcVersion
    }

    try {
      if (inst.source === 'curseforge' && inst.cfProjectId && inst.cfFileId) {
        const result = await installCurseForgeModpack({
          cf: cfClient(),
          paths: p,
          instanceId: inst.id,
          projectId: inst.cfProjectId,
          fileId: inst.cfFileId,
          report
        })
        inst.mcVersion = result.mcVersion
        inst.loader = result.loader
        inst.loaderVersion = result.loaderVersion
        const versionId = await installLoader(result.loader, result.mcVersion, result.loaderVersion)
        await installVersion(p, versionId, report)
        inst.launchVersion = versionId
        inst.loaderPending = false
        inst.note =
          result.failedMods > 0
            ? `${result.failedMods} of ${result.totalMods} mods couldn't be auto-downloaded (they opted out of the CurseForge API). Add them manually to the mods folder.`
            : undefined
      } else {
        const versionId = await installLoader(inst.loader, inst.mcVersion, inst.loaderVersion)
        await installVersion(p, versionId, report)
        inst.launchVersion = versionId
      }
      inst.installed = true
      persist()
      return inst
    } catch (err) {
      report('error', 'Install failed', -1, (err as Error).message)
      throw err
    }
  }

  // ── Settings / account ─────────────────────────────────────────────────────
  ipcMain.handle(IPC.getSettings, () => settings)
  ipcMain.handle(IPC.getSystemInfo, () => ({ totalMemoryMb, maxRamMb }))
  ipcMain.handle(IPC.saveSettings, (_e, patch: Partial<typeof settings>) => {
    settings = { ...settings, ...patch }
    settings.ramMb = clampRam(settings.ramMb)
    saveSettings(settings)
    return settings
  })
  ipcMain.handle(IPC.getAccount, () => makeOfflineAccount(username))
  ipcMain.handle(IPC.saveAccount, (_e, name: string) => {
    username = name.trim() || 'Player'
    saveUsername(username)
    return makeOfflineAccount(username)
  })

  // ── Java / versions ────────────────────────────────────────────────────────
  ipcMain.handle(IPC.discoverJava, () => discoverJava(settings.javaPath))
  ipcMain.handle(IPC.listVersions, async () => {
    const manifest = await fetchVersionManifest()
    return { latest: manifest.latest, versions: manifest.versions }
  })
  ipcMain.handle(IPC.fabricVersions, async (_e, mcVersion: string) => {
    const versions = await getFabricLoaderVersions(mcVersion)
    return versions.map((v) => ({ version: v.loader.version, stable: v.loader.stable }))
  })
  ipcMain.handle(IPC.loaderVersions, async (_e, loader: LoaderType, mcVersion: string) => {
    if (loader === 'fabric') {
      const versions = await getFabricLoaderVersions(mcVersion)
      return versions.map((v) => ({ version: v.loader.version, stable: v.loader.stable }))
    }
    if (loader === 'forge') return getForgeVersions(mcVersion)
    if (loader === 'neoforge') return getNeoForgeVersions(mcVersion)
    return []
  })

  // ── Instances ──────────────────────────────────────────────────────────────
  ipcMain.handle(IPC.listInstances, () => instances)
  ipcMain.handle(IPC.createInstance, (_e, input: CreateInstanceInput) => {
    const inst: Instance = {
      id: randomUUID(),
      name: input.name.trim() || `${input.loader} ${input.mcVersion}`,
      mcVersion: input.mcVersion,
      loader: input.loader,
      loaderVersion: input.loaderVersion,
      source: 'vanilla',
      ramMb: input.ramMb,
      createdAt: new Date().toISOString(),
      installed: false
    }
    instances = [inst, ...instances]
    persist()
    return inst
  })
  ipcMain.handle(IPC.updateInstance, (_e, id: string, patch: Partial<Instance>) => {
    const inst = findInstance(id)
    if (typeof patch.ramMb === 'number') patch.ramMb = clampRam(patch.ramMb)
    Object.assign(inst, patch)
    persist()
    return inst
  })
  ipcMain.handle(IPC.deleteInstance, async (_e, id: string) => {
    running.get(id)?.kill()
    running.delete(id)
    instances = instances.filter((i) => i.id !== id)
    persist()
    await rm(paths().instanceDir(id), { recursive: true, force: true }).catch(() => undefined)
  })
  ipcMain.handle(IPC.installInstance, (_e, id: string) => doInstall(findInstance(id)))

  ipcMain.handle(IPC.launchInstance, async (_e, id: string): Promise<LaunchResult> => {
    let inst = findInstance(id)
    try {
      if (running.has(id)) return { ok: false, error: 'This instance is already running.' }
      if (!inst.installed) inst = await doInstall(inst)

      const report = reporterFor(id)
      const p = paths()
      report('launching', 'Preparing launch', -1)
      if (settings.launchMode === 'official') {
        const versionId = inst.launchVersion ?? inst.mcVersion
        report('launching', 'Syncing with Minecraft Launcher', -1)
        await registerOfficialProfile(
          p,
          { ...inst, ramMb: clampRam(inst.ramMb ?? settings.ramMb) },
          settings,
          versionId
        )
        await openOfficialLauncher()
        report('done', 'Minecraft Launcher opened', 1, `Choose “Openforge · ${inst.name}” and press Play.`)
        return { ok: true }
      }
      const version = await resolveVersion(p, inst.launchVersion ?? inst.mcVersion)
      report('natives', 'Checking LWJGL natives', -1)
      const nativeCount = await prepareNatives(p, version)
      logFor(id, 'system', `[Openforge] Verified ${nativeCount} loadable LWJGL native files for ${process.platform}/${process.arch}.`)

      const requiredJava = version.javaVersion?.majorVersion ?? 8
      const java = await selectJava(requiredJava, settings.javaPath)
      if (!java) {
        const installed = await discoverJava(settings.javaPath)
        const have = installed.length
          ? `Found only Java ${installed.map((j) => j.majorVersion).join(', ')}.`
          : 'No Java runtime was found at all.'
        const msg =
          `Minecraft ${version.id} needs Java ${requiredJava} or newer. ${have} ` +
          `Install a matching JDK (Adoptium/Temurin recommended) and set its path in Settings.`
        report('error', 'Incompatible Java', -1, msg)
        return { ok: false, error: msg }
      }

      const account = launchAccount(makeOfflineAccount(username))
      const startedAt = Date.now()
      const hideLauncher = settings.closeLauncherOnLaunch
      const game = await launchGame({
        paths: p,
        version,
        instanceDir: p.instanceDir(id),
        account,
        settings: { ...settings, javaPath: java.path },
        ramMb: clampRam(inst.ramMb ?? settings.ramMb),
        onLog: (stream, line) => logFor(id, stream, line),
        onExit: (code) => {
          running.delete(id)
          const played = Math.round((Date.now() - startedAt) / 1000)
          inst.totalPlaySeconds = (inst.totalPlaySeconds ?? 0) + played
          persist()
          report('done', code === 0 ? 'Game closed' : `Game exited (code ${code})`, 1)
          if (hideLauncher) {
            getWindow()?.show()
            getWindow()?.focus()
          }
        }
      })
      running.set(id, game)
      inst.lastPlayed = new Date().toISOString()
      persist()
      report('running', 'Game running', 1, `pid ${game.pid}`)
      if (hideLauncher) getWindow()?.hide()
      return { ok: true }
    } catch (err) {
      reporterFor(id)('error', 'Launch failed', -1, (err as Error).message)
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle(IPC.killInstance, (_e, id: string) => {
    running.get(id)?.kill()
    running.delete(id)
  })
  ipcMain.handle(IPC.listMods, (_e, id: string) => listMods(id))
  ipcMain.handle(IPC.importMods, async (_e, id: string) => {
    const win = getWindow()
    const result = await dialog.showOpenDialog(win ?? undefined!, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Minecraft mods', extensions: ['jar'] }]
    })
    if (!result.canceled) {
      const dir = modsDir(id)
      await mkdir(dir, { recursive: true })
      for (const source of result.filePaths) await copyFile(source, join(dir, basename(source)))
    }
    return listMods(id)
  })
  ipcMain.handle(IPC.toggleMod, async (_e, id: string, fileName: string, enabled: boolean) => {
    const clean = safeModName(fileName)
    const dir = modsDir(id)
    const currentlyDisabled = clean.toLowerCase().endsWith('.disabled')
    const target = enabled
      ? clean.replace(/\.disabled$/i, '')
      : currentlyDisabled
        ? clean
        : `${clean}.disabled`
    if (target !== clean) await rename(join(dir, clean), join(dir, target))
    return listMods(id)
  })
  ipcMain.handle(IPC.deleteMod, async (_e, id: string, fileName: string) => {
    await rm(join(modsDir(id), safeModName(fileName)))
    await forgetManagedMod(paths().instanceDir(id), fileName)
    return listMods(id)
  })
  ipcMain.handle(IPC.installCfMod, async (_e, id: string, projectId: number) => {
    const instance = findInstance(id)
    const result = await installCurseForgeMod({
      cf: cfClient(),
      instance,
      instanceDir: paths().instanceDir(id),
      projectId
    })
    result.mods = await listMods(id)
    return result
  })
  ipcMain.handle(IPC.updateMods, async (_e, id: string) => {
    const instance = findInstance(id)
    const result = await updateManagedMods({
      cf: cfClient(),
      instance,
      instanceDir: paths().instanceDir(id)
    })
    result.mods = await listMods(id)
    return result
  })
  ipcMain.handle(IPC.exportPack, async (_e, id: string) => {
    const instance = findInstance(id)
    const win = getWindow()
    const suggested = instance.name.replace(/[<>:"/\\|?*]/g, '-')
    const result = await dialog.showSaveDialog(win ?? undefined!, {
      title: 'Export shareable modpack',
      defaultPath: `${suggested}.zip`,
      filters: [{ name: 'CurseForge modpack', extensions: ['zip'] }]
    })
    if (result.canceled || !result.filePath) return null
    await exportCurseForgePack({
      instance,
      instanceDir: paths().instanceDir(id),
      destination: result.filePath
    })
    return result.filePath
  })

  // ── CurseForge ─────────────────────────────────────────────────────────────
  ipcMain.handle(IPC.cfStatus, () => {
    const mode = settings.cfProxyUrl ? 'proxy' : settings.cfApiKey ? 'direct' : 'none'
    return { available: mode !== 'none', mode }
  })
  ipcMain.handle(IPC.cfSearch, (_e, input: CfSearchInput) =>
    cfClient().search({ ...input, classId: input.kind === 'mod' ? MOD_CLASS : MODPACK_CLASS })
  )
  ipcMain.handle(IPC.cfMod, (_e, modId: number) => cfClient().getMod(modId))
  ipcMain.handle(IPC.cfFiles, (_e, modId: number, page: number) => cfClient().getFiles(modId, page))
  ipcMain.handle(IPC.cfInstall, async (_e, input: CfInstallInput) => {
    const inst: Instance = {
      id: randomUUID(),
      name: input.name.trim() || 'CurseForge Modpack',
      mcVersion: 'unknown',
      loader: 'vanilla',
      source: 'curseforge',
      cfProjectId: input.projectId,
      cfFileId: input.fileId,
      iconUrl: input.iconUrl,
      createdAt: new Date().toISOString(),
      installed: false
    }
    instances = [inst, ...instances]
    persist()
    return doInstall(inst)
  })

  // ── OS integration ─────────────────────────────────────────────────────────
  ipcMain.handle(IPC.pickDirectory, async () => {
    const win = getWindow()
    const res = await dialog.showOpenDialog(win ?? undefined!, { properties: ['openDirectory', 'createDirectory'] })
    return res.canceled ? null : res.filePaths[0]
  })
  ipcMain.handle(IPC.openExternal, (_e, url: string) => shell.openExternal(url))
  ipcMain.handle(IPC.openFolder, (_e, path: string) => shell.openPath(path))
}
