import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { arch, totalmem } from 'node:os'
import { copyFile, cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, resolve as resolvePath, sep } from 'node:path'
import type {
  CleanupResult,
  ContentKind,
  Instance,
  InstalledMod,
  JavaInfo,
  JavaRuntimeStatus,
  LaunchStep,
  LoaderType,
  LogLine,
  NetworkCheck,
  RetargetInput,
  RetargetPlan,
  RetargetResult,
  ProgressEvent,
  Provider,
  Settings
} from '@shared/types'
import { LOADERS } from '@shared/types'
import { IPC } from '@shared/ipc'
import type {
  AddFilesResult,
  ContentSearchInput,
  CreateInstanceInput,
  InstallContentInput,
  InstanceSubfolder,
  LaunchResult,
  PackInstallInput,
  PackUpdateInfo,
  PlayStatus,
  ProviderStatus,
  QuickPlayInput
} from '@shared/ipc'
import { diagnoseCrash, type FixAction } from '@shared/errors'
import { recommendedRamMb } from '@shared/tuning'
import { GamePaths } from './core/paths'
import {
  defaultSettings,
  loadInstances,
  loadLegacyUsername,
  loadSettings,
  saveInstances,
  saveSettings
} from './core/store'
import { applySettingsPatch } from '@shared/settings'
import { AccountStore } from './core/accounts'
import { discoverJava, pickJava, probeJava } from './core/java'
import {
  ensureRuntime,
  listManagedRuntimes,
  provisionableMajor,
  removeRuntime,
  SUPPORTED_MAJORS
} from './core/javaprovision'
import { fetchVersionManifest } from './core/manifest'
import {
  ensureVersionJar,
  installVersion,
  isVersionReady,
  prepareNatives,
  resolveVersion,
  Reporter,
  VerifyMode
} from './core/installer'
import { readKeyBindings, resetKeyBindings } from './core/options'
import { installedModIds, listConfigFiles, planCleanup } from './core/cleanup'
import { getFabricLikeVersions, installFabricLike } from './core/fabric'
import { getForgeVersions, getNeoForgeVersions, installForgeLike } from './core/forge'
import { launchGame, RunningGame } from './core/launcher'
import { CfClient } from './core/curseforge'
import { builtinCfKey } from './core/builtinkey'
import { ModrinthClient } from './core/modrinth'
import { installPack, installPackFromFile, readPackIndex } from './core/packinstall'
import {
  applyRetargetPlan,
  checkForUpdates,
  deleteContent,
  exportCurseForgePack,
  exportMrpack,
  FOLDER,
  importLocalFile,
  installContent,
  listContent,
  planRetarget,
  toggleContent,
  updateAll
} from './core/content'
import { backupWorld, listWorlds } from './core/worlds'
import { minecraftDir, openOfficialLauncher, registerOfficialProfile } from './core/official-launcher'
import { checkOfflinePlayAllowed, detectLauncherInstall } from './core/ownership'
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
  const cfClient = (): CfClient => new CfClient(settings.cfProxyUrl, settings.cfApiKey, builtinCfKey())
  const modrinth = new ModrinthClient()
  const clients = (): { cf: CfClient; modrinth: ModrinthClient } => ({ cf: cfClient(), modrinth })
  const concurrency = (): number => Math.min(64, Math.max(1, settings.downloadConcurrency || 16))

  const send = (channel: string, payload: unknown): void => {
    getWindow()?.webContents.send(channel, payload)
  }
  const sendProgress = (evt: ProgressEvent): void => send(IPC.progressEvent, evt)
  /** A reporter for installs; during a launch, `step` tags events for the step indicator. */
  const reporterFor =
    (instanceId: string, step?: LaunchStep): Reporter =>
    (phase, label, progress, detail) =>
      sendProgress({ instanceId, phase, label, progress, detail, step: phase === 'done' ? undefined : step })

  // The tail of each game's output, kept for crash diagnosis.
  const recentLog = new Map<string, string[]>()
  const logFor = (instanceId: string, stream: LogLine['stream'], line: string): void => {
    const evt: LogLine = { instanceId, stream, line, ts: Date.now() }
    send(IPC.logEvent, evt)
    if (stream !== 'system') {
      const tail = recentLog.get(instanceId) ?? []
      tail.push(line)
      if (tail.length > 400) tail.splice(0, tail.length - 400)
      recentLog.set(instanceId, tail)
    }
  }

  const persist = (): void => saveInstances(instances)
  const findInstance = (id: string): Instance => {
    const inst = instances.find((i) => i.id === id)
    if (!inst) throw new Error('Instance not found')
    return inst
  }
  const instanceDirOf = (id: string): string => paths().instanceDir(id)

  /** Resolve a path inside an instance, refusing anything that escapes it. */
  const insideInstance = (id: string, relPath: string): string => {
    const root = resolvePath(instanceDirOf(id))
    const target = resolvePath(root, ...String(relPath).split(/[\\/]+/))
    if (target === root || !target.startsWith(root + sep)) throw new Error('That path is outside the instance.')
    return target
  }
  const modCountOf = (id: string): number => {
    try {
      return readdirSync(join(instanceDirOf(id), 'mods')).filter((name) => /\.jar$/i.test(name)).length
    } catch {
      return 0
    }
  }
  /**
   * The heap a launch gets: the profile's own setting, or for modded profiles
   * left on automatic, whichever is larger of the global default and what the
   * pack size and this machine's RAM suggest.
   */
  const effectiveRam = (inst: Instance): number => {
    if (inst.ramMb) return clampRam(inst.ramMb)
    if (inst.loader === 'vanilla') return clampRam(settings.ramMb)
    const recommended = recommendedRamMb({
      totalMemoryMb,
      maxRamMb,
      loader: inst.loader,
      modCount: modCountOf(inst.id)
    })
    return clampRam(Math.max(settings.ramMb, recommended))
  }

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
  // Discovery spawns `java -version` for every candidate. Remember the answer
  // per required major for the session, so a warm launch probes nothing.
  const javaCache = new Map<number, JavaInfo>()
  const forgetJava = (): void => javaCache.clear()

  async function resolveJava(
    requiredMajor: number,
    instance: Instance | null,
    report?: Reporter
  ): Promise<JavaInfo> {
    if (instance?.javaPath) {
      const explicit = await probeJava(instance.javaPath)
      if (explicit) return explicit
      logFor(instance.id, 'system', `[Openforge] Java override ${instance.javaPath} did not run; using automatic Java.`)
    }
    const cached = javaCache.get(requiredMajor)
    if (cached && existsSync(cached.path)) return cached

    // Minecraft up to 1.16 (and every LaunchWrapper-era Forge) breaks on Java 9+,
    // so with managed Java on, only an exact Java 8 is acceptable.
    const strictLegacy = requiredMajor <= 8 && settings.autoJava
    const accept = (list: JavaInfo[]): JavaInfo | null =>
      strictLegacy ? list.find((java) => java.majorVersion === 8) ?? null : pickJava(list, requiredMajor)

    // Managed runtimes first: probing two or three known paths is quick.
    const managed = (await Promise.all((await managedJavaPaths()).map((path) => probeJava(path)))).filter(
      (java): java is JavaInfo => Boolean(java)
    )
    const exactManaged = managed.find((java) => java.majorVersion === requiredMajor)
    let picked: JavaInfo | null = exactManaged ? { ...exactManaged, managed: true } : null
    if (!picked) {
      const found = await discoverJava(settings.javaPath, await managedJavaPaths())
      picked = accept(found)
    }
    if (!picked && settings.autoJava) {
      picked = await ensureRuntime(paths(), provisionableMajor(requiredMajor), report)
    }
    if (picked) {
      javaCache.set(requiredMajor, picked)
      return picked
    }
    const found = await discoverJava(settings.javaPath, await managedJavaPaths())
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
    report: Reporter,
    mode: VerifyMode = 'quick'
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
        onLog: (line) => logFor(inst.id, 'system', line),
        concurrency: concurrency(),
        mode
      })
    }
    return mcVersion
  }

  // One install or launch per instance at a time; double-clicking Play must
  // not start two installers writing the same files.
  const installing = new Set<string>()
  const launching = new Set<string>()
  const userStopped = new Set<string>()

  /** Full install of an instance: pack files, loader, then the game itself. */
  async function doInstall(inst: Instance, mode: VerifyMode = 'quick'): Promise<Instance> {
    if (installing.has(inst.id)) throw new Error('This instance is already being installed.')
    installing.add(inst.id)
    try {
      return await installSteps(inst, mode)
    } finally {
      installing.delete(inst.id)
    }
  }

  async function installSteps(inst: Instance, mode: VerifyMode): Promise<Instance> {
    const report = reporterFor(inst.id)
    const p = paths()
    const started = Date.now()

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
        const versionId = await installLoader(inst, result.loader, result.mcVersion, result.loaderVersion, report, mode)
        await installVersion(p, versionId, report, concurrency(), mode)
        inst.launchVersion = versionId
        inst.loaderPending = false
      } else {
        const versionId = await installLoader(inst, inst.loader, inst.mcVersion, inst.loaderVersion, report, mode)
        await installVersion(p, versionId, report, concurrency(), mode)
        inst.launchVersion = versionId
      }
      logFor(inst.id, 'system', `[Openforge] Install finished in ${((Date.now() - started) / 1000).toFixed(1)}s.`)

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
  // Settings save on every change (the renderer debounces typing), so this
  // must be cheap and must leave the app consistent after each call: values
  // are normalized, and anything cached from the old value is dropped here.
  ipcMain.handle(IPC.saveSettings, (_e, patch: Partial<Settings>) => {
    const previous = settings
    settings = applySettingsPatch(settings, patch, defaultSettings())
    settings.ramMb = clampRam(settings.ramMb)
    if (
      settings.javaPath !== previous.javaPath ||
      settings.autoJava !== previous.autoJava ||
      settings.gameDir !== previous.gameDir
    ) {
      forgetJava()
    }
    saveSettings(settings)
    if (settings.proxyUrl !== previous.proxyUrl) void applyProxySettings(settings.proxyUrl)
    return settings
  })

  ipcMain.handle(IPC.networkCheck, async (): Promise<NetworkCheck[]> => {
    const targets = [
      { name: 'Mojang version manifest', url: 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json' },
      { name: 'Minecraft assets CDN', url: 'https://resources.download.minecraft.net/' },
      { name: 'Modrinth API', url: 'https://api.modrinth.com/v2/tag/loader' },
      { name: 'Modrinth CDN', url: 'https://cdn.modrinth.com/' },
      // The bucket root answers 403 by design (no listing); any HTTP answer means reachable.
      { name: 'CurseForge CDN', url: 'https://mediafilez.forgecdn.net/', anyResponse: true },
      { name: 'Fabric meta', url: 'https://meta.fabricmc.net/v2/versions/game' },
      { name: 'NeoForge maven', url: 'https://maven.neoforged.net/releases/' },
      { name: 'Adoptium (Java)', url: 'https://api.adoptium.net/v3/info/available_releases' }
    ]
    const probes: Promise<NetworkCheck>[] = (targets as { name: string; url: string; anyResponse?: boolean }[]).map(
      async ({ name, url, anyResponse }) => {
        const result = await probeUrl(url)
        return {
          name,
          url,
          ok: anyResponse ? result.status !== undefined : result.ok,
          status: result.status,
          error: result.error,
          // Name the failure mode the user can actually act on.
          tlsIntercepted: Boolean(result.error?.includes('trusted HTTPS connection'))
        }
      }
    )
    // Exercise the configured CurseForge credential (proxy, own key or built-in
    // key) with one tiny search, so a rejected key is told apart from a network problem.
    const cf = cfClient()
    if (cf.available) {
      probes.push(
        cf.search({ pageSize: 1 }).then(
          () => ({ name: `CurseForge API (${cf.mode})`, url: 'https://api.curseforge.com/v1/mods/search', ok: true, status: 200 }),
          (err: Error) => ({
            name: `CurseForge API (${cf.mode})`,
            url: 'https://api.curseforge.com/v1/mods/search',
            ok: false,
            error: err.message,
            tlsIntercepted: err.message.includes('trusted HTTPS connection')
          })
        )
      )
    }
    return Promise.all(probes)
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

  // Microsoft sign-in is switched off (core/features.ts); its IPC lives,
  // unregistered, in msauth-ipc.ts.

  // -- How the game is played ---------------------------------------------------
  ipcMain.handle(
    IPC.playStatus,
    (): PlayStatus => {
      const gate = checkOfflinePlayAllowed(minecraftDir())
      const install = detectLauncherInstall(process.env)
      return {
        offline: { allowed: gate.allowed, reason: gate.reason, profileNames: gate.profileNames },
        launcher: { installed: install.installed, kind: install.kind }
      }
    }
  )
  ipcMain.handle(IPC.openOfficialLauncher, () => openOfficialLauncher())

  // -- Java -------------------------------------------------------------------
  ipcMain.handle(IPC.discoverJava, async () => discoverJava(settings.javaPath, await managedJavaPaths()))
  ipcMain.handle(IPC.javaRuntimes, async (): Promise<JavaRuntimeStatus[]> => {
    const managed = await listManagedRuntimes(paths())
    return SUPPORTED_MAJORS.map(({ major, usedFor }) => {
      const hit = managed.find((runtime) => runtime.majorVersion === major)
      return { majorVersion: major, installed: Boolean(hit), path: hit?.path, usedFor }
    })
  })
  ipcMain.handle(IPC.installJavaRuntime, async (_e, major: number) => {
    forgetJava()
    return ensureRuntime(paths(), major, reporterFor('java'))
  })
  ipcMain.handle(IPC.removeJavaRuntime, async (_e, major: number) => {
    forgetJava()
    return removeRuntime(paths(), major)
  })

  // -- Versions / loaders -----------------------------------------------------
  ipcMain.handle(IPC.listVersions, async () => {
    try {
      const manifest = await fetchVersionManifest()
      return { latest: manifest.latest, versions: manifest.versions }
    } catch (err) {
      // The launcher must still open and run installed instances when Mojang is
      // unreachable. The connection check under Settings -> Content providers -> Advanced explains why.
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
    if (patch.name !== undefined) {
      const name = patch.name.trim()
      if (!name || name.length > 80) throw new Error('Profile name must be 1–80 characters.')
      inst.name = name
    }
    // 0 means "automatic": drop the override so the recommendation applies.
    if (typeof patch.ramMb === 'number') {
      if (patch.ramMb <= 0) delete inst.ramMb
      else inst.ramMb = clampRam(patch.ramMb)
    }
    if (patch.jvmArgs !== undefined) inst.jvmArgs = String(patch.jvmArgs).slice(0, 4000)
    if (patch.javaPath !== undefined) {
      inst.javaPath = String(patch.javaPath).trim() || undefined
      forgetJava()
    }
    if (patch.iconUrl !== undefined) {
      const icon = String(patch.iconUrl)
      // A pack's https icon, a small picture the editor resized, or nothing.
      if (!icon) delete inst.iconUrl
      else if (/^https:\/\/\S+$/i.test(icon) && icon.length < 2048) inst.iconUrl = icon
      else if (/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(icon) && icon.length < 400_000) inst.iconUrl = icon
      else throw new Error('That icon could not be used. Pick a PNG, JPEG or WebP image.')
    }
    persist()
    return inst
  })
  ipcMain.handle(IPC.deleteInstance, async (_e, id: string) => {
    running.get(id)?.kill()
    running.delete(id)
    instances = instances.filter((i) => i.id !== id)
    persist()
    // Worlds live in here. Prefer the Recycle Bin so a mis-click is recoverable;
    // fall back to deleting only when the OS refuses (e.g. a folder too big for it).
    const dir = instanceDirOf(id)
    if (!existsSync(dir)) return
    try {
      await shell.trashItem(dir)
    } catch {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
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
    if (running.has(id)) throw new Error('Stop the game before repairing its files.')
    inst.installed = false
    persist()
    // Repair re-hashes everything instead of trusting the install stamps.
    return doInstall(inst, 'full')
  })
  const SUBFOLDERS: InstanceSubfolder[] = ['mods', 'config', 'resourcepacks', 'shaderpacks', 'saves', 'logs', 'crash-reports']
  ipcMain.handle(IPC.openInstanceFolder, async (_e, id: string, sub?: InstanceSubfolder) => {
    const dir = sub && SUBFOLDERS.includes(sub) ? join(instanceDirOf(id), sub) : instanceDirOf(id)
    await mkdir(dir, { recursive: true })
    const error = await shell.openPath(dir)
    if (error) throw new Error(error)
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
      if (running.has(id)) return { ok: false, error: 'This instance is already running.' }
      if (launching.has(id) || installing.has(id)) return { ok: false, error: 'This instance is already starting.' }
      launching.add(id)
      const step = (s: LaunchStep, label: string, detail?: string): void =>
        sendProgress({ instanceId: id, phase: 'launching', label, progress: -1, detail, step: s })
      try {
        if (!inst.installed) inst = await doInstall(inst)
        const started = Date.now()
        const p = paths()

        if (settings.launchMode === 'official') {
          const versionId = inst.launchVersion ?? inst.mcVersion
          report('launching', 'Syncing with Minecraft Launcher', -1)
          await registerOfficialProfile(p, { ...inst, ramMb: effectiveRam(inst) }, settings, versionId)
          await openOfficialLauncher()
          report('done', 'Minecraft Launcher opened', 1, `Choose "Openforge - ${inst.name}" and press Play.`)
          return { ok: true }
        }

        // Offline play needs evidence that Minecraft was bought on this PC.
        const gate = checkOfflinePlayAllowed(minecraftDir())
        if (!gate.allowed) {
          const msg =
            `${gate.reason} Sign in to the official Minecraft Launcher once with an account that owns ` +
            'Java Edition, then press Play again - or play through the Minecraft Launcher.'
          sendProgress({
            instanceId: id,
            phase: 'error',
            label: 'Minecraft account needed',
            progress: -1,
            detail: msg,
            action: 'launcher'
          })
          return { ok: false, error: msg, handled: true }
        }

        const active = accounts.active()
        if (!active) {
          const msg = 'Add an offline profile before playing. Open the account menu to pick a name.'
          sendProgress({
            instanceId: id,
            phase: 'error',
            label: 'No account selected',
            progress: -1,
            detail: msg,
            action: 'accounts'
          })
          return { ok: false, error: msg, handled: true }
        }

        // Warm path: when the install stamp still matches the disk, nothing
        // below touches the network or hashes a file.
        step('files', 'Checking game files')
        const versionId = inst.launchVersion ?? inst.mcVersion
        let version = await resolveVersion(p, versionId)
        const ready = await isVersionReady(p, version)
        if (!ready.fresh) {
          logFor(id, 'system', `[Openforge] Refreshing game files (${ready.reason ?? 'not verified yet'}).`)
          version = await installVersion(p, versionId, reporterFor(id, 'files'), concurrency(), 'quick')
        }
        await ensureVersionJar(p, version)
        const nativeCount = await prepareNatives(p, version)
        logFor(
          id,
          'system',
          `[Openforge] ${nativeCount} LWJGL native files ready for ${process.platform}/${process.arch}.`
        )

        step('java', 'Finding Java')
        const java = await resolveJava(version.javaVersion?.majorVersion ?? 8, inst, reporterFor(id, 'java'))
        logFor(id, 'system', `[Openforge] Using Java ${java.majorVersion} at ${java.path}`)

        step('account', `Playing as ${active.username}`)
        const account = await accounts.resolveForLaunch(active.id, settings.msClientId)
        if (account.userType === 'legacy' && quickPlay?.type === 'multiplayer') {
          logFor(
            id,
            'system',
            '[Openforge] Offline profile: online-mode servers will refuse this connection.'
          )
        }

        step('start', 'Starting Minecraft')
        const ramMb = effectiveRam(inst)
        const startedAt = Date.now()
        const hideLauncher = settings.closeLauncherOnLaunch
        const modded = inst.loader !== 'vanilla'
        recentLog.delete(id)
        userStopped.delete(id)
        const game = await launchGame({
          paths: p,
          version,
          instanceDir: p.instanceDir(id),
          account,
          settings,
          javaPath: java.path,
          javaMajor: java.majorVersion,
          loader: inst.loader,
          ramMb,
          extraJvmArgs: inst.jvmArgs,
          quickPlay,
          onLog: (stream, line) => logFor(id, stream, line),
          onStage: (stage) =>
            sendProgress({
              instanceId: id,
              phase: 'running',
              label: stage === 'ready' ? 'Playing' : modded ? 'Loading mods' : 'Loading Minecraft',
              progress: stage === 'ready' ? 1 : -1,
              step: stage === 'ready' ? 'ready' : 'loading'
            }),
          onExit: (code) => {
            running.delete(id)
            const played = Math.round((Date.now() - startedAt) / 1000)
            inst.totalPlaySeconds = (inst.totalPlaySeconds ?? 0) + played
            persist()
            const stopped = userStopped.delete(id)
            if (code === 0 || stopped) {
              report(
                'done',
                stopped ? 'Game stopped' : 'Game closed',
                1,
                `Played ${Math.max(1, Math.round(played / 60))} min`
              )
            } else {
              const diagnosis = diagnoseCrash(recentLog.get(id) ?? [])
              const action: FixAction = diagnosis?.action ?? 'console'
              sendProgress({
                instanceId: id,
                phase: 'error',
                label: diagnosis?.title ?? `Minecraft closed unexpectedly (code ${code})`,
                progress: -1,
                detail: diagnosis?.fix ?? 'Open the console to see the last lines the game printed.',
                action
              })
            }
            if (hideLauncher) {
              getWindow()?.show()
              getWindow()?.focus()
            }
          }
        })
        running.set(id, game)
        inst.lastPlayed = new Date().toISOString()
        persist()
        const prepMs = Date.now() - started
        logFor(
          id,
          'system',
          `[Openforge] ${ready.fresh ? 'Warm launch' : 'Launch'} prepared in ${prepMs} ms, ` +
            `${(ramMb / 1024).toFixed(1)} GB heap, pid ${game.pid}.`
        )
        sendProgress({
          instanceId: id,
          phase: 'running',
          label: 'Starting Minecraft',
          progress: -1,
          detail: `Ready in ${(prepMs / 1000).toFixed(1)}s`,
          step: 'start'
        })
        if (hideLauncher) getWindow()?.hide()
        return { ok: true }
      } catch (err) {
        const message =
          err instanceof TlsInterceptionError ? err.message : (err as Error).message
        report('error', 'Launch failed', -1, message)
        return { ok: false, error: message, handled: true }
      } finally {
        launching.delete(id)
      }
    }
  )

  ipcMain.handle(IPC.killInstance, (_e, id: string) => {
    if (running.has(id)) userStopped.add(id)
    running.get(id)?.kill()
    running.delete(id)
  })

  // -- Key bindings, mod configs, cleanup ----------------------------------------
  const optionsPathOf = (id: string): string => join(instanceDirOf(id), 'options.txt')
  const readOptions = async (id: string): Promise<string | null> =>
    readFile(optionsPathOf(id), 'utf8').catch(() => null)
  const refuseWhileRunning = (id: string, what: string): void => {
    if (running.has(id) || launching.has(id)) {
      throw new Error(`Close Minecraft before ${what}. The game rewrites these files when it exits.`)
    }
  }

  ipcMain.handle(IPC.listKeyBindings, async (_e, id: string) => {
    findInstance(id)
    return readKeyBindings(await readOptions(id))
  })
  ipcMain.handle(IPC.resetKeyBindings, async (_e, id: string, ids: string[] | null) => {
    findInstance(id)
    refuseWhileRunning(id, 'resetting key bindings')
    const text = await readOptions(id)
    if (text === null) throw new Error('This profile has no options.txt yet. Start the game once to create it.')
    // Keep one backup of the file as it was before the latest reset.
    await copyFile(optionsPathOf(id), `${optionsPathOf(id)}.openforge-backup`).catch(() => undefined)
    const next = resetKeyBindings(text, Array.isArray(ids) ? ids.map(String) : null)
    await writeFile(optionsPathOf(id), next, 'utf8')
    return readKeyBindings(next)
  })
  ipcMain.handle(IPC.openOptionsFile, async (_e, id: string) => {
    findInstance(id)
    if (!existsSync(optionsPathOf(id))) {
      throw new Error('This profile has no options.txt yet. Start the game once to create it.')
    }
    const error = await shell.openPath(optionsPathOf(id))
    if (error) throw new Error(error)
  })
  ipcMain.handle(IPC.listConfigFiles, async (_e, id: string) => {
    const inst = findInstance(id)
    const dir = instanceDirOf(id)
    const ids = inst.loader === 'vanilla' ? null : await installedModIds(dir)
    return listConfigFiles(dir, ids && ids.length ? ids : null)
  })
  ipcMain.handle(IPC.openConfigFile, async (_e, id: string, relPath: string, reveal?: boolean) => {
    findInstance(id)
    if (!/^(config|defaultconfigs)\//.test(String(relPath))) {
      throw new Error('Only files under config/ can be opened here.')
    }
    const target = insideInstance(id, relPath)
    if (!existsSync(target)) throw new Error('That config file no longer exists.')
    if (reveal) {
      shell.showItemInFolder(target)
      return
    }
    const error = await shell.openPath(target)
    if (error) throw new Error(`${error} Use "Show in folder" to pick an editor.`)
  })
  ipcMain.handle(IPC.planCleanup, async (_e, id: string) => {
    const inst = findInstance(id)
    return planCleanup(instanceDirOf(id), inst.loader !== 'vanilla')
  })
  ipcMain.handle(IPC.runCleanup, async (_e, id: string, relPaths: string[]): Promise<CleanupResult> => {
    const inst = findInstance(id)
    refuseWhileRunning(id, 'cleaning up')
    // Only what a fresh plan still lists may go: the renderer cannot name
    // arbitrary paths, and anything that changed since the preview is skipped.
    const plan = await planCleanup(instanceDirOf(id), inst.loader !== 'vanilla')
    const allowed = new Map(plan.items.map((item) => [item.relPath, item]))
    const result: CleanupResult = { trashed: [], failed: [], bytes: 0 }
    for (const relPath of Array.isArray(relPaths) ? relPaths.map(String) : []) {
      const item = allowed.get(relPath)
      if (!item) {
        result.failed.push({ relPath, error: 'No longer part of the cleanup plan.' })
        continue
      }
      try {
        await shell.trashItem(insideInstance(id, relPath))
        result.trashed.push(relPath)
        result.bytes += item.bytes
      } catch (err) {
        result.failed.push({ relPath, error: (err as Error).message })
      }
    }
    return result
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
      versionId: input.versionId ? String(input.versionId) : undefined,
      replaceFileName: input.replaceFileName ? safeFileName(String(input.replaceFileName)) : undefined
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

  // Files dropped onto an instance's content tab.
  ipcMain.handle(
    IPC.addContentFiles,
    async (_e, id: string, kind: ContentKind, paths: string[]): Promise<AddFilesResult> => {
      findInstance(id)
      const resolved = kindOf(kind)
      const wanted = resolved === 'mod' ? '.jar' : '.zip'
      const added: string[] = []
      const skipped: string[] = []
      for (const raw of Array.isArray(paths) ? paths.slice(0, 200) : []) {
        const path = String(raw)
        const name = basename(path)
        try {
          if (!isAbsolute(path)) throw new Error('not a file on this computer')
          if (extname(name).toLowerCase() !== wanted) {
            throw new Error(resolved === 'mod' ? 'mods are .jar files' : `${resolved === 'shader' ? 'shader packs' : 'packs'} are .zip files`)
          }
          const info = await stat(path)
          if (!info.isFile()) throw new Error('not a file')
          if (info.size > 1024 * 1024 * 1024) throw new Error('larger than 1 GB')
          await importLocalFile(instanceDirOf(id), resolved, path)
          added.push(name)
        } catch (err) {
          skipped.push(`${name} (${(err as Error).message})`)
        }
      }
      return { mods: await listContent(instanceDirOf(id), resolved), added, skipped }
    }
  )

  // -- Changing an instance's Minecraft version or loader ------------------------
  const retargetTarget = (value: { mcVersion?: unknown; loader?: unknown }): { mcVersion: string; loader: LoaderType } => {
    const mcVersion = String(value?.mcVersion ?? '').trim()
    const loader = String(value?.loader ?? '') as LoaderType
    if (!/^[\w.\- ]{1,48}$/.test(mcVersion)) throw new Error('Pick a Minecraft version.')
    if (!LOADERS.includes(loader)) throw new Error('Pick a mod loader.')
    return { mcVersion, loader }
  }
  const tracksPack = (inst: Instance): boolean => Boolean(inst.provider && inst.projectId && inst.versionId)

  ipcMain.handle(
    IPC.planRetarget,
    async (_e, id: string, target: { mcVersion: string; loader: LoaderType }): Promise<RetargetPlan> => {
      const inst = findInstance(id)
      const { mcVersion, loader } = retargetTarget(target)
      const items = await planRetarget({ clients: clients(), instance: inst, instanceDir: instanceDirOf(id), mcVersion, loader })
      return { mcVersion, loader, items, detachesPack: tracksPack(inst) }
    }
  )

  ipcMain.handle(IPC.retargetInstance, async (_e, id: string, input: RetargetInput): Promise<RetargetResult> => {
    const inst = findInstance(id)
    if (running.has(id) || launching.has(id) || installing.has(id)) {
      throw new Error('Close Minecraft and wait for installs to finish before changing the version.')
    }
    const { mcVersion, loader } = retargetTarget(input)
    const loaderVersion = input.loaderVersion ? String(input.loaderVersion).trim() : undefined
    if ((loader === 'forge' || loader === 'neoforge') && !loaderVersion) {
      throw new Error(`Pick a ${loader === 'forge' ? 'Forge' : 'NeoForge'} version.`)
    }

    const target: Instance = { ...inst, mcVersion, loader, loaderVersion: loader === 'vanilla' ? undefined : loaderVersion }
    let outcome = { updated: [] as string[], disabled: [] as string[], failed: [] as string[] }
    if (input.updateMods || input.disableMissing) {
      const items = await planRetarget({ clients: clients(), instance: inst, instanceDir: instanceDirOf(id), mcVersion, loader })
      outcome = await applyRetargetPlan({
        clients: clients(),
        instance: target,
        instanceDir: instanceDirOf(id),
        items,
        updateMods: Boolean(input.updateMods),
        disableMissing: Boolean(input.disableMissing)
      })
    }

    inst.mcVersion = target.mcVersion
    inst.loader = target.loader
    inst.loaderVersion = target.loaderVersion
    // A pack install would put the old version straight back, so the profile
    // stops following the pack; its files stay exactly as they are.
    if (tracksPack(inst)) {
      delete inst.provider
      delete inst.projectId
      delete inst.versionId
      delete inst.cfProjectId
      delete inst.cfFileId
      delete inst.updateAvailable
      delete inst.packVersion
    }
    inst.installed = false
    delete inst.launchVersion
    delete inst.loaderPending
    persist()
    logFor(id, 'system', `[Openforge] Profile moved to ${loaderLabelOf(loader)} ${mcVersion}${loaderVersion ? ` (${loaderVersion})` : ''}.`)
    return { instance: inst, ...outcome }
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

function loaderLabelOf(loader: LoaderType): string {
  return { vanilla: 'Vanilla', fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge', quilt: 'Quilt' }[loader]
}
