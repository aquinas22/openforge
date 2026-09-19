import type {
  AccountSummary,
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
  Settings,
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
}

export interface QuickPlayInput {
  type: 'singleplayer' | 'multiplayer' | 'realms'
  id: string
}

export interface LaunchResult {
  ok: boolean
  error?: string
}

export interface ProviderStatus {
  modrinth: boolean
  curseforge: { available: boolean; mode: 'proxy' | 'direct' | 'none'; bulk: boolean }
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
  startMicrosoftLogin(): Promise<DeviceCodePrompt>
  cancelMicrosoftLogin(): Promise<void>

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
  openInstanceFolder(id: string): Promise<void>
  listWorlds(id: string): Promise<WorldSummary[]>
  backupWorld(id: string, folderName: string): Promise<string | null>

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

  // -- Discover ---------------------------------------------------------------
  searchContent(input: ContentSearchInput): Promise<ContentSearchResult>
  getProject(provider: Provider, id: string): Promise<ContentProject>
  getVersions(provider: Provider, id: string): Promise<ContentVersion[]>
  providerStatus(): Promise<ProviderStatus>

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
  /** Fires while a Microsoft sign-in is waiting on the browser. */
  onAuthEvent(cb: (e: AuthEvent) => void): () => void
}

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
  startMicrosoftLogin: 'accounts:msStart',
  cancelMicrosoftLogin: 'accounts:msCancel',

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

  searchContent: 'discover:search',
  getProject: 'discover:project',
  getVersions: 'discover:versions',
  providerStatus: 'discover:status',

  pickDirectory: 'dialog:pickDir',
  pickFile: 'dialog:pickFile',
  openExternal: 'app:openExternal',
  openFolder: 'app:openFolder',

  winMinimize: 'win:minimize',
  winMaximize: 'win:maximize',
  winClose: 'win:close',

  progressEvent: 'evt:progress',
  logEvent: 'evt:log',
  authEvent: 'evt:auth'
} as const
