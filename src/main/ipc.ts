import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { arch, totalmem } from 'node:os'
import { cp, mkdir, rm } from 'node:fs/promises'
import { basename } from 'node:path'
import type {
  ContentKind,
  Instance,
  InstalledMod,
  JavaInfo,
  JavaRuntimeStatus,
  LoaderType,
  LogLine,
  NetworkCheck,
  ProgressEvent,
  Provider,
  Settings
} from '@shared/types'
import { IPC } from '@shared/ipc'
import type {
  AuthEvent,
  ContentSearchInput,
  CreateInstanceInput,
  InstallContentInput,
  LaunchResult,
  PackInstallInput,
  PackUpdateInfo,
  ProviderStatus,
  QuickPlayInput
} from '@shared/ipc'
import { GamePaths } from './core/paths'
import { loadInstances, loadLegacyUsername, loadSettings, saveInstances, saveSettings } from './core/store'
import { AccountStore } from './core/accounts'
import { startDeviceCode, pollForTokens, authenticateMinecraft, MicrosoftAuthError } from './core/msauth'
import { discoverJava, pickJava, probeJava } from './core/java'
import {
  ensureRuntime,
  listManagedRuntimes,
  provisionableMajor,
  removeRuntime,
  SUPPORTED_MAJORS
} from './core/javaprovision'
import { fetchVersionManifest } from './core/manifest'
import { installVersion, prepareNatives, resolveVersion, Reporter } from './core/installer'
import { getFabricLikeVersions, installFabricLike } from './core/fabric'
import { getForgeVersions, getNeoForgeVersions, installForgeLike } from './core/forge'
import { launchGame, RunningGame } from './core/launcher'
import { CfClient } from './core/curseforge'
import { ModrinthClient } from './core/modrinth'
import { installPack, installPackFromFile, readPackIndex } from './core/packinstall'
import {
  checkForUpdates,
  deleteContent,
  exportCurseForgePack,
  exportMrpack,
  FOLDER,
  importLocalFile,
  installContent,
  listContent,
  toggleContent,
  updateAll
} from './core/content'
import { backupWorld, listWorlds } from './core/worlds'
import { openOfficialLauncher, registerOfficialProfile } from './core/official-launcher'
import { probeUrl, TlsInterceptionError } from './core/http'
import { applyProxySettings } from './core/network'

export function registerIpc(getWindow: () => BrowserWindow | null): void {
  let settings = loadSettings()
  let instances = loadInstances()
  const accounts = new AccountStore()
  accounts.migrateLegacyUsername(loadLegacyUsername())

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

  void applyProxySettings(settings.proxyUrl)

  const paths = (): GamePaths => new GamePaths(settings.gameDir)
  const cfClient = (): CfClient => new CfClient(settings.cfProxyUrl, settings.cfApiKey)
  const modrinth = new ModrinthClient()
  const clients = (): { cf: CfClient; modrinth: ModrinthClient } => ({ cf: cfClient(), modrinth })
  const concurrency = (): number => Math.min(64, Math.max(1, settings.downloadConcurrency || 16))

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
  const instanceDirOf = (id: string): string => paths().instanceDir(id)

  /** A file name that cannot escape the folder it belongs to. */
  const safeFileName = (name: string): string => {
    const clean = basename(name)
    if (clean !== name || clean.startsWith('.')) throw new Error('Invalid file name.')
    return clean
  }
  const kindOf = (value: unknown): ContentKind => {
    const kind = String(value) as ContentKind
    if (!(kind in FOLDER)) throw new Error(`Unknown content kind "${String(value)}".`)
    return kind
  }

  // -- Java -------------------------------------------------------------------

  const managedJavaPaths = async (): Promise<string[]> =>
    (await listManagedRuntimes(paths())).map((runtime) => runtime.path)

  /**
   * Find a Java that can run this Minecraft version, downloading one if the
   * machine has nothing suitable. This is the step that used to send new
   * players away to install a JDK before they could play anything.
   */
  async function resolveJava(
    requiredMajor: number,
    instance: Instance | null,
    report?: Reporter
  ): Promise<JavaInfo> {
    if (instance?.javaPath) {
      const explicit = await probeJava(instance.javaPath)
      if (explicit) return explicit
    }
    const found = await discoverJava(settings.javaPath, await managedJavaPaths())
    const picked = pickJava(found, requiredMajor)
    if (picked) return picked

    if (settings.autoJava) {
      return ensureRuntime(paths(), provisionableMajor(requiredMajor), report)
    }
    const have = found.length
      ? `Found only Java ${found.map((j) => j.majorVersion).join(', ')}.`
      : 'No Java runtime was found on this machine.'
    throw new Error(
      `This version of Minecraft needs Java ${requiredMajor} or newer. ${have} ` +
        'Turn on "Manage Java automatically" in Settings, or install a matching JDK and set its path.'
    )
  }

  // -- Install ----------------------------------------------------------------

  const installLoader = async (
    inst: Instance,
    loader: LoaderType,
    mcVersion: string,
    loaderVersion: string | undefined,
    report: Reporter
  ): Promise<string> => {
    const p = paths()
    if (loader === 'fabric' || loader === 'quilt') {
      report('loader', `Installing ${loader === 'quilt' ? 'Quilt' : 'Fabric'}`, -1, mcVersion)
      return installFabricLike(loader, p, mcVersion, loaderVersion)
    }
    if (loader === 'forge' || loader === 'neoforge') {
      if (!loaderVersion) throw new Error(`Missing ${loader} version for ${mcVersion}.`)
      const vanilla = await resolveVersion(p, mcVersion)
      const java = await resolveJava(vanilla.javaVersion?.majorVersion ?? 8, inst, report)
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

  /** Full install of an instance: pack files, loader, then the game itself. */
  async function doInstall(inst: Instance): Promise<Instance> {
    const report = reporterFor(inst.id)
    const p = paths()

    try {
      if (inst.provider && inst.projectId && inst.versionId) {
        const result = await installPack({
          provider: inst.provider,
          cf: cfClient(),
          modrinth,
          paths: p,
          instanceId: inst.id,
          projectId: inst.projectId,
          versionId: inst.versionId,
          report,
          concurrency: concurrency()
        })
        inst.mcVersion = result.mcVersion
        inst.loader = result.loader
        inst.loaderVersion = result.loaderVersion
        inst.packVersion = result.packVersion
        inst.manualDownloads = result.manualDownloads.length ? result.manualDownloads : undefined
        inst.note = result.manualDownloads.length
          ? `${result.manualDownloads.length} of ${result.totalFiles} files could not be downloaded automatically. ` +
            'Open the instance to get them.'
          : undefined
        const versionId = await installLoader(inst, result.loader, result.mcVersion, result.loaderVersion, report)
        await installVersion(p, versionId, report, concurrency())
        inst.launchVersion = versionId
        inst.loaderPending = false
      } else {
        const versionId = await installLoader(inst, inst.loader, inst.mcVersion, inst.loaderVersion, report)
        await installVersion(p, versionId, report, concurrency())
        inst.launchVersion = versionId
      }

      // Provision the runtime now, so the first Play is instant rather than a
      // surprise 50 MB download.
      if (settings.autoJava) {
        const version = await resolveVersion(p, inst.launchVersion ?? inst.mcVersion)
        await resolveJava(version.javaVersion?.majorVersion ?? 8, inst, report).catch((err) =>
          logFor(inst.id, 'system', `[Openforge] Java pre-fetch skipped: ${(err as Error).message}`)
        )
      }

      inst.installed = true
      persist()
      report('done', 'Ready to play', 1)
      return inst
    } catch (err) {
      report('error', 'Install failed', -1, (err as Error).message)
      throw err
    }
  }

  // -- Settings / system ------------------------------------------------------
  ipcMain.handle(IPC.getSettings, () => settings)
  ipcMain.handle(IPC.getSystemInfo, () => ({
    totalMemoryMb,
    maxRamMb,
    platform: process.platform,
    arch: arch()
  }))
  ipcMain.handle(IPC.saveSettings, (_e, patch: Partial<Settings>) => {
    const previousProxy = settings.proxyUrl
    settings = { ...settings, ...patch }
    settings.ramMb = clampRam(settings.ramMb)
    saveSettings(settings)
    if (settings.proxyUrl !== previousProxy) void applyProxySettings(settings.proxyUrl)
    return settings
  })

  ipcMain.handle(IPC.networkCheck, async (): Promise<NetworkCheck[]> => {
    const targets = [
      { name: 'Mojang version manifest', url: 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json' },
      { name: 'Minecraft assets CDN', url: 'https://resources.download.minecraft.net/' },
      { name: 'Modrinth API', url: 'https://api.modrinth.com/v2/tag/loader' },
      { name: 'Modrinth CDN', url: 'https://cdn.modrinth.com/' },
      { name: 'CurseForge CDN', url: 'https://mediafilez.forgecdn.net/' },
      { name: 'Fabric meta', url: 'https://meta.fabricmc.net/v2/versions/game' },
      { name: 'NeoForge maven', url: 'https://maven.neoforged.net/releases/' },
      { name: 'Adoptium (Java)', url: 'https://api.adoptium.net/v3/info/available_releases' },
      { name: 'Microsoft sign-in', url: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize' }
    ]
    return Promise.all(
      targets.map(async ({ name, url }) => {
        const result = await probeUrl(url)
        return {
          name,
          url,
          ok: result.ok,
          status: result.status,
          error: result.error,
          // Name the failure mode the user can actually act on.
          tlsIntercepted: Boolean(result.error?.includes('trusted HTTPS connection'))
        }
      })
    )
  })

  // -- Accounts ---------------------------------------------------------------
  ipcMain.handle(IPC.listAccounts, () => accounts.list())
  ipcMain.handle(IPC.addOfflineAccount, (_e, username: string) => {
    accounts.addOffline(username)
    return accounts.list()
  })
  ipcMain.handle(IPC.setActiveAccount, (_e, id: string) => {
    accounts.setActive(id)
    return accounts.list()
  })
  ipcMain.handle(IPC.removeAccount, (_e, id: string) => {
    accounts.remove(id)
    return accounts.list()
  })

  // A sign-in runs in the background while the user completes it in a browser.
  let signInAbort: AbortController | null = null
  const sendAuth = (event: AuthEvent): void => send(IPC.authEvent, event)

  ipcMain.handle(IPC.startMicrosoftLogin, async () => {
    signInAbort?.abort()
    const controller = new AbortController()
    signInAbort = controller

    const start = await startDeviceCode(settings.msClientId)
    const prompt = {
      userCode: start.userCode,
      verificationUri: start.verificationUri,
      expiresInSeconds: start.expiresIn,
      message: start.message
    }

    void (async () => {
      try {
        const tokens = await pollForTokens(settings.msClientId, start, { signal: controller.signal })
        const session = await authenticateMinecraft(tokens.accessToken)
        accounts.addMicrosoft(session, tokens)
        if (!accounts.encryptionAvailable) {
          sendAuth({
            kind: 'error',
            message:
              `Signed in as ${session.username}, but this system offers no secure credential storage, ` +
              'so the session will not be remembered after you quit.'
          })
        }
        sendAuth({ kind: 'success', username: session.username })
      } catch (err) {
        if ((err as MicrosoftAuthError).code === 'cancelled') sendAuth({ kind: 'cancelled' })
        else sendAuth({ kind: 'error', message: (err as Error).message })
      } finally {
        if (signInAbort === controller) signInAbort = null
      }
    })()

    return prompt
  })
  ipcMain.handle(IPC.cancelMicrosoftLogin, () => {
    signInAbort?.abort()
    signInAbort = null
  })

  // -- Java -------------------------------------------------------------------
  ipcMain.handle(IPC.discoverJava, async () => discoverJava(settings.javaPath, await managedJavaPaths()))
  ipcMain.handle(IPC.javaRuntimes, async (): Promise<JavaRuntimeStatus[]> => {
    const managed = await listManagedRuntimes(paths())
    return SUPPORTED_MAJORS.map(({ major, usedFor }) => {
      const hit = managed.find((runtime) => runtime.majorVersion === major)
      return { majorVersion: major, installed: Boolean(hit), path: hit?.path, usedFor }
    })
  })
  ipcMain.handle(IPC.installJavaRuntime, (_e, major: number) =>
    ensureRuntime(paths(), major, reporterFor('java'))
  )
  ipcMain.handle(IPC.removeJavaRuntime, (_e, major: number) => removeRuntime(paths(), major))

  // -- Versions / loaders -----------------------------------------------------
  ipcMain.handle(IPC.listVersions, async () => {
    try {
      const manifest = await fetchVersionManifest()
      return { latest: manifest.latest, versions: manifest.versions }
    } catch (err) {
      // The launcher must still open and run installed instances when Mojang is
      // unreachable. Settings -> Network is where the reason gets explained.
      console.warn('[Openforge] Version manifest unavailable:', (err as Error).message)
      return { latest: { release: '', snapshot: '' }, versions: [] }
    }
  })
  ipcMain.handle(IPC.loaderVersions, async (_e, loader: LoaderType, mcVersion: string) => {
    if (loader === 'fabric' || loader === 'quilt') return getFabricLikeVersions(loader, mcVersion)
    if (loader === 'forge') return getForgeVersions(mcVersion)
    if (loader === 'neoforge') return getNeoForgeVersions(mcVersion)
    return []
  })

  // -- Instances --------------------------------------------------------------
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
    await rm(instanceDirOf(id), { recursive: true, force: true }).catch(() => undefined)
  })
  ipcMain.handle(IPC.duplicateInstance, async (_e, id: string) => {
    const source = findInstance(id)
    const copy: Instance = {
      ...source,
      id: randomUUID(),
      name: `${source.name} copy`,
      createdAt: new Date().toISOString(),
      lastPlayed: undefined,
      totalPlaySeconds: 0
    }
    // Worlds and configs come along; the shared game files never do, because
    // versions/libraries/assets live outside the instance folder already.
    await cp(instanceDirOf(id), instanceDirOf(copy.id), { recursive: true }).catch(() => undefined)
    instances = [copy, ...instances]
    persist()
    return copy
  })
  ipcMain.handle(IPC.installInstance, (_e, id: string) => doInstall(findInstance(id)))
  ipcMain.handle(IPC.repairInstance, async (_e, id: string) => {
    const inst = findInstance(id)
    inst.installed = false
    persist()
    return doInstall(inst)
  })
  ipcMain.handle(IPC.openInstanceFolder, async (_e, id: string) => {
    const dir = instanceDirOf(id)
    await mkdir(dir, { recursive: true })
    await shell.openPath(dir)
  })
  ipcMain.handle(IPC.listWorlds, (_e, id: string) => listWorlds(instanceDirOf(id)))
  ipcMain.handle(IPC.backupWorld, async (_e, id: string, folderName: string) =>
    backupWorld(instanceDirOf(id), safeFileName(folderName))
  )

  // -- Launch -----------------------------------------------------------------
  ipcMain.handle(
    IPC.launchInstance,
    async (_e, id: string, quickPlay?: QuickPlayInput): Promise<LaunchResult> => {
      let inst = findInstance(id)
      const report = reporterFor(id)
      try {
        if (running.has(id)) return { ok: false, error: 'This instance is already running.' }
        if (!inst.installed) inst = await doInstall(inst)

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
          report('done', 'Minecraft Launcher opened', 1, `Choose "Openforge - ${inst.name}" and press Play.`)
          return { ok: true }
        }

        const active = accounts.active()
        if (!active) {
          const msg = 'Add an account before playing. Open the account menu to sign in or create an offline profile.'
          report('error', 'No account selected', -1, msg)
          return { ok: false, error: msg }
        }

        const version = await resolveVersion(p, inst.launchVersion ?? inst.mcVersion)
        report('natives', 'Checking LWJGL natives', -1)
        const nativeCount = await prepareNatives(p, version)
        logFor(
          id,
          'system',
          `[Openforge] Verified ${nativeCount} loadable LWJGL native files for ${process.platform}/${process.arch}.`
        )

        const java = await resolveJava(version.javaVersion?.majorVersion ?? 8, inst, report)
        logFor(id, 'system', `[Openforge] Using Java ${java.majorVersion} at ${java.path}`)

        const account = await accounts.resolveForLaunch(active.id, settings.msClientId)
        if (account.userType === 'legacy' && quickPlay?.type === 'multiplayer') {
          logFor(
            id,
            'system',
            '[Openforge] Offline profile: online-mode servers will refuse this connection.'
          )
        }

        const startedAt = Date.now()
        const hideLauncher = settings.closeLauncherOnLaunch
        const game = await launchGame({
          paths: p,
          version,
          instanceDir: p.instanceDir(id),
          account,
          settings,
          javaPath: java.path,
          ramMb: clampRam(inst.ramMb ?? settings.ramMb),
          extraJvmArgs: inst.jvmArgs,
          quickPlay,
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
        const message =
          err instanceof TlsInterceptionError ? err.message : (err as Error).message
        report('error', 'Launch failed', -1, message)
        return { ok: false, error: message }
      }
    }
  )

  ipcMain.handle(IPC.killInstance, (_e, id: string) => {
    running.get(id)?.kill()
    running.delete(id)
  })

  // -- Packs ------------------------------------------------------------------
  ipcMain.handle(IPC.installPack, async (_e, input: PackInstallInput) => {
    const inst: Instance = {
      id: randomUUID(),
      name: input.name.trim() || 'Modpack',
      mcVersion: 'unknown',
      loader: 'vanilla',
      source: input.provider,
      provider: input.provider,
      projectId: input.projectId,
      versionId: input.versionId,
      iconUrl: input.iconUrl,
      createdAt: new Date().toISOString(),
      installed: false
    }
    instances = [inst, ...instances]
    persist()
    return doInstall(inst)
  })

  ipcMain.handle(IPC.importPack, async () => {
    const win = getWindow()
    const result = await dialog.showOpenDialog(win ?? undefined!, {
      title: 'Import a modpack',
      properties: ['openFile'],
      filters: [
        { name: 'Modpacks', extensions: ['mrpack', 'zip'] },
        { name: 'Modrinth modpack', extensions: ['mrpack'] },
        { name: 'CurseForge modpack', extensions: ['zip'] }
      ]
    })
    if (result.canceled || !result.filePaths[0]) return null

    const archivePath = result.filePaths[0]
    const inst: Instance = {
      id: randomUUID(),
      name: basename(archivePath).replace(/\.(mrpack|zip)$/i, ''),
      mcVersion: 'unknown',
      loader: 'vanilla',
      source: 'import',
      createdAt: new Date().toISOString(),
      installed: false
    }
    instances = [inst, ...instances]
    persist()

    const report = reporterFor(inst.id)
    try {
      const packResult = await installPackFromFile({
        cf: cfClient(),
        archivePath,
        instanceDir: instanceDirOf(inst.id),
        report,
        concurrency: concurrency()
      })
      inst.name = packResult.name || inst.name
      inst.mcVersion = packResult.mcVersion
      inst.loader = packResult.loader
      inst.loaderVersion = packResult.loaderVersion
      inst.packVersion = packResult.packVersion
      inst.manualDownloads = packResult.manualDownloads.length ? packResult.manualDownloads : undefined
      const versionId = await installLoader(
        inst,
        packResult.loader,
        packResult.mcVersion,
        packResult.loaderVersion,
        report
      )
      await installVersion(paths(), versionId, report, concurrency())
      inst.launchVersion = versionId
      inst.installed = true
      persist()
      report('done', 'Imported', 1, inst.name)
      return inst
    } catch (err) {
      report('error', 'Import failed', -1, (err as Error).message)
      instances = instances.filter((entry) => entry.id !== inst.id)
      persist()
      throw err
    }
  })

  ipcMain.handle(IPC.exportPack, async (_e, id: string, format: 'mrpack' | 'curseforge') => {
    const instance = findInstance(id)
    const win = getWindow()
    const suggested = instance.name.replace(/[<>:"/\\|?*]/g, '-')
    const extension = format === 'mrpack' ? 'mrpack' : 'zip'
    const result = await dialog.showSaveDialog(win ?? undefined!, {
      title: 'Export modpack',
      defaultPath: `${suggested}.${extension}`,
      filters: [
        format === 'mrpack'
          ? { name: 'Modrinth modpack', extensions: ['mrpack'] }
          : { name: 'CurseForge modpack', extensions: ['zip'] }
      ]
    })
    if (result.canceled || !result.filePath) return null
    const args = { instance, instanceDir: instanceDirOf(id), destination: result.filePath }
    if (format === 'mrpack') await exportMrpack(args)
    else await exportCurseForgePack(args)
    return result.filePath
  })

  ipcMain.handle(IPC.checkPackUpdate, async (_e, id: string): Promise<PackUpdateInfo> => {
    const inst = findInstance(id)
    if (!inst.provider || !inst.projectId) return { available: false }
    const versions =
      inst.provider === 'modrinth'
        ? await modrinth.getVersions(inst.projectId)
        : await cfClient().getVersions(inst.projectId, 0, 20)
    const newest = versions.filter((v) => !v.isServerPack)[0]
    if (!newest || newest.id === inst.versionId) {
      inst.updateAvailable = undefined
      persist()
      return { available: false }
    }
    inst.updateAvailable = {
      versionId: newest.id,
      versionNumber: newest.versionNumber,
      name: newest.name
    }
    persist()
    return {
      available: true,
      versionId: newest.id,
      versionNumber: newest.versionNumber,
      name: newest.name
    }
  })

  ipcMain.handle(IPC.updatePack, async (_e, id: string) => {
    const inst = findInstance(id)
    if (!inst.updateAvailable) throw new Error('This instance is already up to date.')
    // The pack installer prunes files the previous release shipped and this one
    // does not, while leaving saves/ and screenshots/ alone.
    inst.versionId = inst.updateAvailable.versionId
    inst.updateAvailable = undefined
    inst.installed = false
    persist()
    return doInstall(inst)
  })

  // -- Content inside an instance ---------------------------------------------
  ipcMain.handle(IPC.listContent, (_e, id: string, kind: ContentKind) =>
    listContent(instanceDirOf(id), kindOf(kind))
  )
  ipcMain.handle(IPC.importContent, async (_e, id: string, kind: ContentKind) => {
    const resolved = kindOf(kind)
    const win = getWindow()
    const extensions = resolved === 'mod' ? ['jar'] : ['zip']
    const result = await dialog.showOpenDialog(win ?? undefined!, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: resolved === 'mod' ? 'Minecraft mods' : 'Packs', extensions }]
    })
    if (!result.canceled) {
      for (const source of result.filePaths) {
        await importLocalFile(instanceDirOf(id), resolved, source)
      }
    }
    return listContent(instanceDirOf(id), resolved)
  })
  ipcMain.handle(
    IPC.toggleContent,
    async (_e, id: string, kind: ContentKind, fileName: string, enabled: boolean) => {
      const resolved = kindOf(kind)
      await toggleContent(instanceDirOf(id), resolved, safeFileName(fileName), enabled)
      return listContent(instanceDirOf(id), resolved)
    }
  )
  ipcMain.handle(IPC.deleteContent, async (_e, id: string, kind: ContentKind, fileName: string) => {
    const resolved = kindOf(kind)
    await deleteContent(instanceDirOf(id), resolved, safeFileName(fileName))
    return listContent(instanceDirOf(id), resolved)
  })
  ipcMain.handle(IPC.installContent, async (_e, id: string, input: InstallContentInput) => {
    const instance = findInstance(id)
    const resolved = kindOf(input.kind)
    const result = await installContent({
      clients: clients(),
      instance,
      instanceDir: instanceDirOf(id),
      provider: input.provider,
      projectId: input.projectId,
      kind: resolved,
      versionId: input.versionId
    })
    result.mods = await listContent(instanceDirOf(id), resolved)
    return result
  })
  ipcMain.handle(
    IPC.checkContentUpdates,
    async (_e, id: string, kind: ContentKind): Promise<InstalledMod[]> =>
      checkForUpdates({
        clients: clients(),
        instance: findInstance(id),
        instanceDir: instanceDirOf(id),
        kind: kindOf(kind)
      })
  )
  ipcMain.handle(IPC.updateContent, async (_e, id: string, kind: ContentKind) => {
    const resolved = kindOf(kind)
    const result = await updateAll({
      clients: clients(),
      instance: findInstance(id),
      instanceDir: instanceDirOf(id),
      kind: resolved
    })
    result.mods = await listContent(instanceDirOf(id), resolved)
    return result
  })

  // -- Discover ---------------------------------------------------------------
  ipcMain.handle(IPC.searchContent, (_e, input: ContentSearchInput) => {
    const provider: Provider = input.provider ?? settings.defaultProvider
    const query = {
      query: input.query,
      page: input.page,
      pageSize: input.pageSize,
      sort: input.sort,
      gameVersion: input.gameVersion,
      loader: input.loader,
      kind: input.kind
    }
    return provider === 'modrinth' ? modrinth.search(query) : cfClient().search(query)
  })
  ipcMain.handle(IPC.getProject, (_e, provider: Provider, id: string) =>
    provider === 'modrinth' ? modrinth.getProject(id) : cfClient().getProject(id)
  )
  ipcMain.handle(IPC.getVersions, (_e, provider: Provider, id: string) =>
    provider === 'modrinth' ? modrinth.getVersions(id) : cfClient().getVersions(id, 0, 50)
  )
  ipcMain.handle(IPC.providerStatus, (): ProviderStatus => {
    const cf = cfClient()
    return {
      modrinth: true,
      curseforge: { available: cf.available, mode: cf.mode, bulk: cf.supportsBulk }
    }
  })

  // -- OS integration ---------------------------------------------------------
  ipcMain.handle(IPC.pickDirectory, async () => {
    const win = getWindow()
    const res = await dialog.showOpenDialog(win ?? undefined!, {
      properties: ['openDirectory', 'createDirectory']
    })
    return res.canceled ? null : res.filePaths[0]
  })
  ipcMain.handle(IPC.pickFile, async (_e, filters: { name: string; extensions: string[] }[]) => {
    const win = getWindow()
    const res = await dialog.showOpenDialog(win ?? undefined!, {
      properties: ['openFile'],
      filters
    })
    return res.canceled ? null : res.filePaths[0]
  })
  ipcMain.handle(IPC.openExternal, (_e, url: string) => {
    // Only ever hand the OS a web link, never a file:// or custom scheme that
    // arrived from provider metadata.
    if (!/^https?:\/\//i.test(url)) throw new Error('Refusing to open a non-web link.')
    return shell.openExternal(url)
  })
  ipcMain.handle(IPC.openFolder, (_e, path: string) => shell.openPath(path))

  // Surface pack-index state for the UI's "tracked pack" badge.
  ipcMain.handle('pack:index', (_e, id: string) => readPackIndex(instanceDirOf(id)))
}
