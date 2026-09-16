// Shared types used across the main process, preload bridge, and renderer.

export type LoaderType = 'vanilla' | 'fabric' | 'forge' | 'neoforge'

export interface VersionSummary {
  id: string
  type: 'release' | 'snapshot' | 'old_beta' | 'old_alpha'
  url: string
  time: string
  releaseTime: string
}

/** A playable, installed instance in the launcher. */
export interface Instance {
  id: string
  name: string
  /** Vanilla Minecraft version, e.g. "1.20.1" */
  mcVersion: string
  loader: LoaderType
  loaderVersion?: string
  /** Where this instance came from. */
  source: 'vanilla' | 'curseforge'
  /** CurseForge pack + file ids, when source === 'curseforge'. */
  cfProjectId?: number
  cfFileId?: number
  iconUrl?: string
  /** RAM override in MB; falls back to global setting when unset. */
  ramMb?: number
  /** ISO timestamp of the last launch, or undefined if never played. */
  lastPlayed?: string
  totalPlaySeconds?: number
  createdAt: string
  /** Whether all files are present and the instance is ready to launch. */
  installed: boolean
  /** The concrete version-folder id to launch (e.g. a Fabric profile id). */
  launchVersion?: string
  /** True when a Forge/NeoForge loader still needs to be provisioned. */
  loaderPending?: boolean
  /** Human-readable status note (e.g. missing mods, pending loader). */
  note?: string
}

export interface OfflineAccount {
  /** Display name used for local and offline-mode play. */
  username: string
  /** Deterministic offline UUID derived from the username. */
  uuid: string
  type: 'offline'
}

export type Account = OfflineAccount

/** Biome themes. Each swaps the ore-vein accent and the banner plate. */
export type ThemeId = 'terra' | 'infernum' | 'finis' | 'tenebrae' | 'glacies' | 'lux'
export type UiStyle = 'modern' | 'classic'
export type LaunchMode = 'official' | 'offline'

export interface Settings {
  gameDir: string
  javaPath: string
  ramMb: number
  jvmArgs: string
  /** Selected biome theme. */
  theme: ThemeId
  /** Shape, spacing, and surface treatment. Independent from the biome colors. */
  uiStyle: UiStyle
  /** Base URL of the CurseForge proxy (e.g. your servercraft server). */
  cfProxyUrl: string
  /** Optional direct CurseForge API key, used only when no proxy is set. */
  cfApiKey: string
  /** Official launcher owns online auth, or Openforge launches directly with an offline identity. */
  launchMode: LaunchMode
  closeLauncherOnLaunch: boolean
  fullscreen: boolean
  resolutionWidth: number
  resolutionHeight: number
}

export interface SystemInfo {
  /** Physical memory reported by the operating system, rounded down to MiB. */
  totalMemoryMb: number
  /** Conservative launcher allocation ceiling that leaves memory for the OS. */
  maxRamMb: number
}

export interface JavaInfo {
  path: string
  version: string
  majorVersion: number
  arch?: string
}

/** Progress events emitted during install/launch, streamed to the renderer. */
export interface ProgressEvent {
  instanceId: string
  phase:
    | 'preparing'
    | 'manifest'
    | 'libraries'
    | 'assets'
    | 'client'
    | 'natives'
    | 'loader'
    | 'mods'
    | 'overrides'
    | 'launching'
    | 'running'
    | 'done'
    | 'error'
  label: string
  /** 0..1 for the current phase, or -1 for indeterminate. */
  progress: number
  detail?: string
}

export interface LogLine {
  instanceId: string
  stream: 'stdout' | 'stderr' | 'system'
  line: string
  ts: number
}

export interface InstalledMod {
  fileName: string
  displayName: string
  enabled: boolean
  size: number
  projectId?: number
  fileId?: number
  version?: string
  updateAvailable?: boolean
}

export interface ModInstallResult {
  mods: InstalledMod[]
  installed: string[]
  dependencies: string[]
}

// ── CurseForge (normalized shapes returned by the proxy / direct client) ──────

export interface CfMod {
  id: number
  name: string
  slug: string
  summary: string
  downloadCount: number
  logo: string | null
  authors: string[]
  categories: string[]
  dateModified: string
  links: Record<string, string>
}

export interface CfFile {
  id: number
  displayName: string
  fileName: string
  fileDate: string
  fileLength: number
  downloadCount: number
  releaseType: 'release' | 'beta' | 'alpha' | 'unknown'
  downloadUrl: string | null
  gameVersions: string[]
  loaders: string[]
  isServerPack: boolean
  serverPackFileId: number | null
  dependencies: { modId: number; relationType: number }[]
}

export interface CfSearchResult {
  packs: CfMod[]
  pagination: { index: number; pageSize: number; resultCount: number; totalCount: number }
}

export type LaunchState = 'idle' | 'installing' | 'launching' | 'running'
