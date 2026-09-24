// Shared types used across the main process, preload bridge, and renderer.

import type { FixAction } from './errors'

export type LoaderType = 'vanilla' | 'fabric' | 'forge' | 'neoforge' | 'quilt'

export const LOADERS: LoaderType[] = ['vanilla', 'fabric', 'forge', 'neoforge', 'quilt']

export interface VersionSummary {
  id: string
  type: 'release' | 'snapshot' | 'old_beta' | 'old_alpha'
  url: string
  time: string
  releaseTime: string
}

// -- Content providers --------------------------------------------------------
// Modrinth and CurseForge describe the same world with different vocabularies.
// Everything the UI touches is normalized into the shapes below so a pack, mod,
// texture pack, or shader looks the same wherever it came from.

export type Provider = 'modrinth' | 'curseforge'

export type ContentKind = 'modpack' | 'mod' | 'resourcepack' | 'shader' | 'datapack'

export type ContentSort = 'popular' | 'downloads' | 'updated' | 'released' | 'follows'

export interface ContentProject {
  provider: Provider
  /** Provider-native id as a string (Modrinth id, CurseForge numeric id). */
  id: string
  slug: string
  name: string
  summary: string
  /** Long-form body/description, only populated by `getProject`. */
  description?: string
  downloads: number
  follows?: number
  iconUrl: string | null
  gallery?: string[]
  authors: string[]
  categories: string[]
  loaders: string[]
  gameVersions: string[]
  updatedAt: string
  kind: ContentKind
  pageUrl?: string
}

export interface ContentDependency {
  projectId: string
  versionId?: string
}

export interface ContentVersion {
  provider: Provider
  id: string
  projectId: string
  name: string
  versionNumber: string
  releaseType: 'release' | 'beta' | 'alpha' | 'unknown'
  datePublished: string
  downloads: number
  gameVersions: string[]
  loaders: string[]
  fileName: string
  fileSize: number
  /** Null when the author opted out of third-party distribution (CurseForge). */
  downloadUrl: string | null
  /** Alternate hosts to try when `downloadUrl` fails. */
  mirrors?: string[]
  sha1?: string
  sha512?: string
  changelog?: string
  dependencies?: ContentDependency[]
  /** CurseForge server packs are not installable as a client instance. */
  isServerPack?: boolean
}

export interface ContentSearchResult {
  hits: ContentProject[]
  total: number
  offset: number
  limit: number
}

/** A pack/mod file the provider refused to hand over; the user must fetch it. */
export interface ManualDownload {
  name: string
  fileName: string
  pageUrl: string
}

// -- Instances ----------------------------------------------------------------

/** A playable, installed instance in the launcher. */
export interface Instance {
  id: string
  name: string
  /** Vanilla Minecraft version, e.g. "1.20.1" */
  mcVersion: string
  loader: LoaderType
  loaderVersion?: string
  /** Where this instance came from. */
  source: 'vanilla' | 'curseforge' | 'modrinth' | 'import'
  /** Provider project/version ids when the instance tracks a published pack. */
  provider?: Provider
  projectId?: string
  versionId?: string
  /** Human-readable pack version, e.g. "1.3.7". */
  packVersion?: string
  /** A newer pack release detected by the update check. */
  updateAvailable?: { versionId: string; versionNumber: string; name: string }
  /** Legacy CurseForge fields, kept so existing instances.json still loads. */
  cfProjectId?: number
  cfFileId?: number
  iconUrl?: string
  /** RAM override in MB; falls back to global setting when unset. */
  ramMb?: number
  /** Per-instance Java override; falls back to the managed/auto runtime. */
  javaPath?: string
  /** Extra JVM flags appended to the global set for this instance only. */
  jvmArgs?: string
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
  /** Files the provider would not serve; the user has to add them by hand. */
  manualDownloads?: ManualDownload[]
}

// -- Accounts -----------------------------------------------------------------

export type AccountKind = 'offline' | 'microsoft'

export interface StoredAccount {
  id: string
  kind: AccountKind
  username: string
  uuid: string
  /** Microsoft accounts only: Xbox user id, surfaced to the game. */
  xuid?: string
  /** Epoch ms after which the Minecraft token must be refreshed. */
  expiresAt?: number
  /** True when the account owns Minecraft: Java Edition. */
  entitled?: boolean
  /** URL of the player's skin head, for the account chip. */
  avatarUrl?: string
  addedAt: string
}

/** What the launcher reports to the UI. Never carries tokens. */
export interface AccountSummary extends StoredAccount {
  active: boolean
  /** Microsoft accounts whose refresh token no longer works. */
  needsReauth?: boolean
}

/** The in-progress state of a Microsoft device-code sign-in. */
export interface DeviceCodePrompt {
  userCode: string
  verificationUri: string
  expiresInSeconds: number
  message: string
}

// -- Java ---------------------------------------------------------------------

export interface JavaInfo {
  path: string
  version: string
  majorVersion: number
  arch?: string
  /** True when Openforge downloaded and manages this runtime itself. */
  managed?: boolean
  vendor?: string
}

/** A Temurin runtime Openforge can fetch on demand. */
export interface JavaRuntimeStatus {
  majorVersion: number
  installed: boolean
  path?: string
  /** Minecraft versions that need this runtime, for the UI's explanation. */
  usedFor: string
}

// -- Settings -----------------------------------------------------------------

/** Biome themes. Each swaps the ore-vein accent and the banner plate. */
export type ThemeId = 'terra' | 'infernum' | 'finis' | 'tenebrae' | 'glacies' | 'lux'
export type UiStyle = 'modern' | 'classic'

/**
 * How a launch is performed.
 *  - `direct`   : Openforge runs the JVM itself, using the selected account
 *                 (Microsoft for online play, or an offline profile).
 *  - `official` : Openforge prepares the install and hands off to the official
 *                 Minecraft Launcher, which owns authentication.
 */
export type LaunchMode = 'direct' | 'official'

export interface Settings {
  gameDir: string
  javaPath: string
  /** Download and manage Temurin runtimes automatically when one is missing. */
  autoJava: boolean
  ramMb: number
  jvmArgs: string
  /** Selected biome theme. */
  theme: ThemeId
  /** Shape, spacing, and surface treatment. Independent from the biome colors. */
  uiStyle: UiStyle
  /** Preferred content provider shown first in Discover. */
  defaultProvider: Provider
  /** Base URL of the CurseForge proxy (e.g. your servercraft server). */
  cfProxyUrl: string
  /** Optional direct CurseForge API key, used only when no proxy is set. */
  cfApiKey: string
  /** Azure application (client) id used for Microsoft sign-in. */
  msClientId: string
  launchMode: LaunchMode
  closeLauncherOnLaunch: boolean
  fullscreen: boolean
  resolutionWidth: number
  resolutionHeight: number
  /** Parallel download workers. Higher is faster on good connections. */
  downloadConcurrency: number
  /** Explicit proxy, e.g. "http://proxy.corp:8080". Empty uses the system one. */
  proxyUrl: string
}

export interface SystemInfo {
  /** Physical memory reported by the operating system, rounded down to MiB. */
  totalMemoryMb: number
  /** Conservative launcher allocation ceiling that leaves memory for the OS. */
  maxRamMb: number
  platform: string
  arch: string
}

/** One row in the Settings -> Network diagnostics table. */
export interface NetworkCheck {
  name: string
  url: string
  ok: boolean
  status?: number
  error?: string
  /** True when the failure looks like HTTPS interception on this network. */
  tlsIntercepted?: boolean
}

// -- Progress / logs ----------------------------------------------------------

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
    | 'java'
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
  /** Where a launch has got to, for the step indicator. Unset during installs. */
  step?: LaunchStep
  /** For errors: the fix the UI should offer. */
  action?: FixAction
}

/** The launch sequence as the player sees it. */
export type LaunchStep = 'files' | 'java' | 'account' | 'start' | 'loading' | 'ready'

export const LAUNCH_STEPS: { key: LaunchStep; label: string }[] = [
  { key: 'files', label: 'Files' },
  { key: 'java', label: 'Java' },
  { key: 'account', label: 'Account' },
  { key: 'start', label: 'Start' },
  { key: 'loading', label: 'Loading' },
  { key: 'ready', label: 'Playing' }
]

// -- Key bindings, configs, cleanup ---------------------------------------------

export interface KeyBinding {
  /** Binding id without the `key_` prefix, e.g. "key.jump". */
  id: string
  label: string
  /** Vanilla group ("Movement") or the mod namespace ("jei"). */
  category: string
  vanilla: boolean
  /** Raw key token as stored in options.txt. */
  key: string
  keyLabel: string
  /** Forge/NeoForge modifier: SHIFT, CONTROL or ALT. */
  modifier?: string
  defaultKey?: string
  defaultLabel?: string
  isDefault: boolean
  conflict: boolean
}

export interface KeyConflict {
  key: string
  keyLabel: string
  ids: string[]
}

export interface KeyBindingReport {
  /** False until the game has been started once and written options.txt. */
  exists: boolean
  /** Pre-1.13 numeric key codes. */
  legacy: boolean
  bindings: KeyBinding[]
  conflicts: KeyConflict[]
}

export interface ConfigFileEntry {
  /** Path relative to the instance folder, always with forward slashes. */
  relPath: string
  size: number
  modified: number
  /** The mod this config most likely belongs to. */
  owner: string
  /** No installed mod matches the owner. */
  orphan: boolean
}

export interface CleanupItem {
  relPath: string
  label: string
  reason: string
  category: 'logs' | 'crash' | 'cache' | 'orphan-config'
  bytes: number
  files: number
  /** Pre-selected in the preview. Heuristic finds are never pre-selected. */
  recommended: boolean
}

export interface CleanupPlan {
  items: CleanupItem[]
  totalBytes: number
}

export interface CleanupResult {
  trashed: string[]
  failed: { relPath: string; error: string }[]
  bytes: number
}

export interface LogLine {
  instanceId: string
  stream: 'stdout' | 'stderr' | 'system'
  line: string
  ts: number
}

// -- Installed content --------------------------------------------------------

export interface InstalledMod {
  fileName: string
  displayName: string
  enabled: boolean
  size: number
  provider?: Provider
  projectId?: string
  versionId?: string
  version?: string
  updateAvailable?: { versionId: string; versionNumber: string }
  /** Which folder it lives in, so one list can cover mods and texture packs. */
  kind: ContentKind
}

export interface ModInstallResult {
  mods: InstalledMod[]
  installed: string[]
  dependencies: string[]
  failed?: string[]
}

// -- Worlds / servers ---------------------------------------------------------

export interface WorldSummary {
  folderName: string
  name: string
  lastPlayed?: number
  sizeMb: number
  gameMode?: string
}

export interface ServerEntry {
  name: string
  address: string
}

export type LaunchState = 'idle' | 'installing' | 'launching' | 'running'

// -- Legacy aliases -----------------------------------------------------------
// The CurseForge-shaped types the first version exposed. Kept so any stored
// data and the smoke script keep compiling while the UI moves to ContentProject.

export interface OfflineAccount {
  username: string
  uuid: string
  type: 'offline'
}

export type Account = OfflineAccount

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
