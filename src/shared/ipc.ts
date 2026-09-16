import type {
  Account,
  CfFile,
  CfMod,
  CfSearchResult,
  Instance,
  InstalledMod,
  ModInstallResult,
  JavaInfo,
  LoaderType,
  LogLine,
  ProgressEvent,
  Settings,
  SystemInfo,
  VersionSummary
} from './types'

export interface CreateInstanceInput {
  name: string
  mcVersion: string
  loader: LoaderType
  loaderVersion?: string
  ramMb?: number
}

export interface CfInstallInput {
  projectId: number
  fileId: number
  name: string
  iconUrl?: string
}

export interface CfSearchInput {
  query?: string
  page?: number
  sort?: 'popular' | 'downloads' | 'updated' | 'released'
  gameVersion?: string
  kind?: 'modpack' | 'mod'
}

export interface LaunchResult {
  ok: boolean
  error?: string
}

/** The full surface exposed to the renderer as `window.openforge`. */
export interface OpenforgeApi {
  getSettings(): Promise<Settings>
  saveSettings(patch: Partial<Settings>): Promise<Settings>
  getSystemInfo(): Promise<SystemInfo>
  getAccount(): Promise<Account>
  saveAccount(username: string): Promise<Account>
  discoverJava(): Promise<JavaInfo[]>
  listVersions(): Promise<{ latest: { release: string; snapshot: string }; versions: VersionSummary[] }>
  fabricVersions(mcVersion: string): Promise<{ version: string; stable: boolean }[]>
  loaderVersions(loader: LoaderType, mcVersion: string): Promise<{ version: string; stable: boolean }[]>

  listInstances(): Promise<Instance[]>
  createInstance(input: CreateInstanceInput): Promise<Instance>
  deleteInstance(id: string): Promise<void>
  updateInstance(id: string, patch: Partial<Instance>): Promise<Instance>
  installInstance(id: string): Promise<Instance>
  launchInstance(id: string): Promise<LaunchResult>
  killInstance(id: string): Promise<void>
  listMods(id: string): Promise<InstalledMod[]>
  importMods(id: string): Promise<InstalledMod[]>
  toggleMod(id: string, fileName: string, enabled: boolean): Promise<InstalledMod[]>
  deleteMod(id: string, fileName: string): Promise<InstalledMod[]>
  installCfMod(id: string, projectId: number): Promise<ModInstallResult>
  updateMods(id: string): Promise<ModInstallResult>
  exportPack(id: string): Promise<string | null>

  cfSearch(input: CfSearchInput): Promise<CfSearchResult>
  cfMod(id: number): Promise<CfMod>
  cfFiles(id: number, page: number): Promise<CfFile[]>
  cfInstall(input: CfInstallInput): Promise<Instance>
  cfStatus(): Promise<{ available: boolean; mode: 'proxy' | 'direct' | 'none' }>

  pickDirectory(): Promise<string | null>
  openExternal(url: string): Promise<void>
  openFolder(path: string): Promise<void>

  minimizeWindow(): void
  toggleMaximizeWindow(): void
  closeWindow(): void

  onProgress(cb: (e: ProgressEvent) => void): () => void
  onLog(cb: (e: LogLine) => void): () => void
}

export const IPC = {
  getSettings: 'settings:get',
  saveSettings: 'settings:save',
  getSystemInfo: 'system:getInfo',
  getAccount: 'account:get',
  saveAccount: 'account:save',
  discoverJava: 'java:discover',
  listVersions: 'versions:list',
  fabricVersions: 'fabric:versions',
  loaderVersions: 'loader:versions',
  listInstances: 'instances:list',
  createInstance: 'instances:create',
  deleteInstance: 'instances:delete',
  updateInstance: 'instances:update',
  installInstance: 'instance:install',
  launchInstance: 'instance:launch',
  killInstance: 'instance:kill',
  listMods: 'mods:list',
  importMods: 'mods:import',
  toggleMod: 'mods:toggle',
  deleteMod: 'mods:delete',
  installCfMod: 'mods:installCf',
  updateMods: 'mods:update',
  exportPack: 'instance:exportPack',
  cfSearch: 'cf:search',
  cfMod: 'cf:mod',
  cfFiles: 'cf:files',
  cfInstall: 'cf:install',
  cfStatus: 'cf:status',
  pickDirectory: 'dialog:pickDir',
  openExternal: 'app:openExternal',
  openFolder: 'app:openFolder',
  winMinimize: 'win:minimize',
  winMaximize: 'win:maximize',
  winClose: 'win:close',
  progressEvent: 'evt:progress',
  logEvent: 'evt:log'
} as const
