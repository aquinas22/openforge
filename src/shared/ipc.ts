import type {
  AccountSummary,
  CleanupPlan,
  CleanupResult,
  ConfigFileEntry,
  KeyBindingReport,
  ContentKind,
  ContentProject,
  ContentSearchResult,
  ContentSort,
  ContentVersion,
  DeviceCodePrompt,
  Instance,
  InstalledMod,
  JavaInfo,
  JavaRuntimeStatus,
  LoaderType,
  LogLine,
  ModInstallResult,
  NetworkCheck,
  ProgressEvent,
  Provider,
  RetargetInput,
  RetargetPlan,
  RetargetResult,
  ServerConfig,
  ServerFolderInfo,
  ServerLogLine,
  ServerStatus,
  Settings,
  SshServerConfig,
  SshTestResult,
  SystemInfo,
  VersionSummary,
  WorldSummary
} from './types'

export interface CreateInstanceInput {
  name: string
  mcVersion: string
  loader: LoaderType
  loaderVersion?: string
  ramMb?: number
}

/** Install a published pack as a new instance. */
export interface PackInstallInput {
  provider: Provider
  projectId: string
  versionId: string
  name: string
  iconUrl?: string
}

export interface ContentSearchInput {
  query?: string
  page?: number
  pageSize?: number
  sort?: ContentSort
  gameVersion?: string
  loader?: LoaderType | ''
  kind?: ContentKind
  provider?: Provider
}

export interface InstallContentInput {
  provider: Provider
  projectId: string
  kind: ContentKind
  versionId?: string
  /** For an update: the installed file this replaces. */
  replaceFileName?: string
}

export interface QuickPlayInput {
  type: 'singleplayer' | 'multiplayer' | 'realms'
  id: string
}

export interface LaunchResult {
  ok: boolean
  error?: string
  /** The error was already reported through a progress event; do not toast it twice. */
  handled?: boolean
}

export interface ProviderStatus {
  modrinth: boolean
  /** Only the mode crosses to the renderer - never a key. 'builtin' = the key this release ships with. */
  curseforge: { available: boolean; mode: 'proxy' | 'direct' | 'builtin' | 'none'; bulk: boolean }
}

export interface PackUpdateInfo {
  available: boolean
  versionId?: string
  versionNumber?: string
  name?: string
}

/** The full surface exposed to the renderer as `window.openforge`. */
export interface OpenforgeApi {
  // -- Settings & system ------------------------------------------------------
  getSettings(): Promise<Settings>
  saveSettings(patch: Partial<Settings>): Promise<Settings>
  getSystemInfo(): Promise<SystemInfo>
  networkCheck(): Promise<NetworkCheck[]>

  // -- Accounts ---------------------------------------------------------------
  listAccounts(): Promise<AccountSummary[]>
  addOfflineAccount(username: string): Promise<AccountSummary[]>
  setActiveAccount(id: string): Promise<AccountSummary[]>
  removeAccount(id: string): Promise<AccountSummary[]>

  // -- How the game is played ---------------------------------------------------
  /** Whether offline play is allowed here, and whether the official launcher is installed. */
  playStatus(): Promise<PlayStatus>
  /** Open the official Minecraft Launcher (legacy install or Microsoft Store app). */
  openOfficialLauncher(): Promise<void>

  // -- Java -------------------------------------------------------------------
  discoverJava(): Promise<JavaInfo[]>
  javaRuntimes(): Promise<JavaRuntimeStatus[]>
  installJavaRuntime(major: number): Promise<JavaInfo>
  removeJavaRuntime(major: number): Promise<void>

  // -- Versions & loaders -----------------------------------------------------
  listVersions(): Promise<{ latest: { release: string; snapshot: string }; versions: VersionSummary[] }>
  loaderVersions(loader: LoaderType, mcVersion: string): Promise<{ version: string; stable: boolean }[]>

  // -- Instances --------------------------------------------------------------
  listInstances(): Promise<Instance[]>
  createInstance(input: CreateInstanceInput): Promise<Instance>
  deleteInstance(id: string): Promise<void>
  duplicateInstance(id: string): Promise<Instance>
  updateInstance(id: string, patch: Partial<Instance>): Promise<Instance>
  installInstance(id: string): Promise<Instance>
  repairInstance(id: string): Promise<Instance>
  launchInstance(id: string, quickPlay?: QuickPlayInput): Promise<LaunchResult>
  killInstance(id: string): Promise<void>
  /** Open the instance folder, or one of its well-known subfolders. */
  openInstanceFolder(id: string, sub?: InstanceSubfolder): Promise<void>
  listWorlds(id: string): Promise<WorldSummary[]>
  backupWorld(id: string, folderName: string): Promise<string | null>

  // -- Key bindings, mod configs, cleanup -------------------------------------
  listKeyBindings(id: string): Promise<KeyBindingReport>
  /** Reset the given binding ids, or every binding when `ids` is null. */
  resetKeyBindings(id: string, ids: string[] | null): Promise<KeyBindingReport>
  openOptionsFile(id: string): Promise<void>
  listConfigFiles(id: string): Promise<ConfigFileEntry[]>
  /** Open a config file in the system editor, or reveal it in its folder. */
  openConfigFile(id: string, relPath: string, reveal?: boolean): Promise<void>
  planCleanup(id: string): Promise<CleanupPlan>
  /** Move the chosen plan items to the system trash. Never deletes outright. */
  runCleanup(id: string, relPaths: string[]): Promise<CleanupResult>

  // -- Packs ------------------------------------------------------------------
  installPack(input: PackInstallInput): Promise<Instance>
  importPack(): Promise<Instance | null>
  exportPack(id: string, format: 'mrpack' | 'curseforge'): Promise<string | null>
  checkPackUpdate(id: string): Promise<PackUpdateInfo>
  updatePack(id: string): Promise<Instance>

  // -- Content inside an instance ---------------------------------------------
  listContent(id: string, kind: ContentKind): Promise<InstalledMod[]>
  importContent(id: string, kind: ContentKind): Promise<InstalledMod[]>
  toggleContent(id: string, kind: ContentKind, fileName: string, enabled: boolean): Promise<InstalledMod[]>
  deleteContent(id: string, kind: ContentKind, fileName: string): Promise<InstalledMod[]>
  installContent(id: string, input: InstallContentInput): Promise<ModInstallResult>
  checkContentUpdates(id: string, kind: ContentKind): Promise<InstalledMod[]>
  updateContent(id: string, kind: ContentKind): Promise<ModInstallResult>
  /** Copy dropped files into the instance; each must suit the kind (.jar mods, .zip packs). */
  addContentFiles(id: string, kind: ContentKind, paths: string[]): Promise<AddFilesResult>
  /** Check the mods against another Minecraft version or loader. Changes nothing. */
  planRetarget(id: string, target: { mcVersion: string; loader: LoaderType }): Promise<RetargetPlan>
  /** Move the instance to another Minecraft version or loader. */
  retargetInstance(id: string, input: RetargetInput): Promise<RetargetResult>
  /** The on-disk path of a file dropped onto the window (Electron webUtils). */
  pathForFile(file: object): string

  // -- Discover ---------------------------------------------------------------
  searchContent(input: ContentSearchInput): Promise<ContentSearchResult>
  getProject(provider: Provider, id: string): Promise<ContentProject>
  getVersions(provider: Provider, id: string): Promise<ContentVersion[]>
  providerStatus(): Promise<ProviderStatus>

  // -- Servers ------------------------------------------------------------------
  listServers(): Promise<ServerConfig[]>
  /** Create (no id) or update a server config. Validated in the main process. */
  saveServer(input: ServerConfigInput): Promise<ServerConfig>
  /** Forget a server. Its folder is never touched. */
  deleteServer(id: string): Promise<void>
  serverStatuses(): Promise<ServerStatus[]>
  serverLog(id: string): Promise<ServerLogLine[]>
  startServer(id: string): Promise<void>
  /** Graceful: sends "stop", then (local) kills after the configured timeout. */
  stopServer(id: string): Promise<void>
  killServer(id: string): Promise<void>
  sendServerCommand(id: string, command: string): Promise<void>
  /** SSH: run the status command now. */
  refreshServer(id: string): Promise<ServerStatus>
  /** SSH: start or stop streaming the log. */
  tailServerLog(id: string, on: boolean): Promise<void>
  testSshConnection(input: Partial<SshServerConfig>): Promise<SshTestResult>
  inspectServerFolder(dir: string): Promise<ServerFolderInfo>
  acceptServerEula(id: string): Promise<void>
  createLocalServer(input: CreateLocalServerInput): Promise<ServerConfig>

  // -- OS integration ---------------------------------------------------------
  pickDirectory(): Promise<string | null>
  pickFile(filters: { name: string; extensions: string[] }[]): Promise<string | null>
  openExternal(url: string): Promise<void>
  openFolder(path: string): Promise<void>

  minimizeWindow(): void
  toggleMaximizeWindow(): void
  closeWindow(): void

  // -- Streams ----------------------------------------------------------------
  onProgress(cb: (e: ProgressEvent) => void): () => void
  onLog(cb: (e: LogLine) => void): () => void
  onServerLog(cb: (e: ServerLogLine) => void): () => void
  onServerStatus(cb: (e: ServerStatus) => void): () => void
}

/** What the server form sends: a config without the fields the main process assigns. */
export type ServerConfigInput = (
  | Omit<Extract<ServerConfig, { kind: 'local' }>, 'id' | 'createdAt'>
  | Omit<Extract<ServerConfig, { kind: 'ssh' }>, 'id' | 'createdAt'>
) & { id?: string }

export interface CreateLocalServerInput {
  name: string
  /** Folder to create the server in. */
  dir: string
  mcVersion: string
  ramMb: number
  /** The player accepted the Minecraft EULA; writes eula=true. */
  acceptEula: boolean
}

export interface PlayStatus {
  /** The ownership gate for offline play (see main/core/ownership.ts). */
  offline: { allowed: boolean; reason: string; profileNames: string[] }
  launcher: { installed: boolean; kind: 'legacy' | 'store' | null }
}

export interface AddFilesResult {
  mods: InstalledMod[]
  added: string[]
  skipped: string[]
}

export type InstanceSubfolder = 'mods' | 'config' | 'resourcepacks' | 'shaderpacks' | 'saves' | 'logs' | 'crash-reports'

/**
 * Events of the Microsoft device-code sign-in. Only used by main/msauth-ipc.ts,
 * which is not registered while Microsoft sign-in is switched off.
 */
export type AuthEvent =
  | { kind: 'prompt'; prompt: DeviceCodePrompt }
  | { kind: 'success'; username: string }
  | { kind: 'error'; message: string }
  | { kind: 'cancelled' }

export const IPC = {
  getSettings: 'settings:get',
  saveSettings: 'settings:save',
  getSystemInfo: 'system:getInfo',
  networkCheck: 'system:networkCheck',

  listAccounts: 'accounts:list',
  addOfflineAccount: 'accounts:addOffline',
  setActiveAccount: 'accounts:setActive',
  removeAccount: 'accounts:remove',

  playStatus: 'play:status',
  openOfficialLauncher: 'play:openLauncher',

  discoverJava: 'java:discover',
  javaRuntimes: 'java:runtimes',
  installJavaRuntime: 'java:install',
  removeJavaRuntime: 'java:remove',

  listVersions: 'versions:list',
  loaderVersions: 'loader:versions',

  listInstances: 'instances:list',
  createInstance: 'instances:create',
  deleteInstance: 'instances:delete',
  duplicateInstance: 'instances:duplicate',
  updateInstance: 'instances:update',
  installInstance: 'instance:install',
  repairInstance: 'instance:repair',
  launchInstance: 'instance:launch',
  killInstance: 'instance:kill',
  openInstanceFolder: 'instance:openFolder',
  listWorlds: 'instance:worlds',
  backupWorld: 'instance:backupWorld',

  listKeyBindings: 'instance:keybinds',
  resetKeyBindings: 'instance:keybindsReset',
  openOptionsFile: 'instance:openOptions',
  listConfigFiles: 'instance:configs',
  openConfigFile: 'instance:openConfig',
  planCleanup: 'instance:cleanupPlan',
  runCleanup: 'instance:cleanupRun',

  installPack: 'pack:install',
  importPack: 'pack:import',
  exportPack: 'pack:export',
  checkPackUpdate: 'pack:checkUpdate',
  updatePack: 'pack:update',

  listContent: 'content:list',
  importContent: 'content:import',
  toggleContent: 'content:toggle',
  deleteContent: 'content:delete',
  installContent: 'content:install',
  checkContentUpdates: 'content:checkUpdates',
  updateContent: 'content:update',
  addContentFiles: 'content:addFiles',
  planRetarget: 'instance:planRetarget',
  retargetInstance: 'instance:retarget',

  searchContent: 'discover:search',
  getProject: 'discover:project',
  getVersions: 'discover:versions',
  providerStatus: 'discover:status',

  listServers: 'servers:list',
  saveServer: 'servers:save',
  deleteServer: 'servers:delete',
  serverStatuses: 'servers:statuses',
  serverLog: 'servers:log',
  startServer: 'servers:start',
  stopServer: 'servers:stop',
  killServer: 'servers:kill',
  sendServerCommand: 'servers:send',
  refreshServer: 'servers:refresh',
  tailServerLog: 'servers:tail',
  testSshConnection: 'servers:testSsh',
  inspectServerFolder: 'servers:inspectFolder',
  setServerEula: 'servers:eula',
  createLocalServer: 'servers:createLocal',

  pickDirectory: 'dialog:pickDir',
  pickFile: 'dialog:pickFile',
  openExternal: 'app:openExternal',
  openFolder: 'app:openFolder',

  winMinimize: 'win:minimize',
  winMaximize: 'win:maximize',
  winClose: 'win:close',

  progressEvent: 'evt:progress',
  logEvent: 'evt:log',
  serverLogEvent: 'evt:serverLog',
  serverStatusEvent: 'evt:serverStatus'
} as const
