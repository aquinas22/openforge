import type { LaunchMode, Provider, Settings, ThemeId, UiStyle } from './types'

/**
 * The settings file's schema, defaults, and migrations. Pure functions with no
 * Electron dependency, shared by the main process (which owns settings.json)
 * and the renderer (which needs `effectiveProvider`), and exercised directly by
 * scripts/verify.ts.
 *
 * Compatibility rules:
 *  - unknown keys are carried through untouched, so a file written by a newer
 *    build (or read by an older one) loses nothing;
 *  - retired keys that still mean something (msClientId) are kept, so the
 *    feature they belong to can be switched back on without re-entry;
 *  - a value of the wrong type or out of range falls back to its default
 *    instead of breaking the launcher.
 */

/**
 * 1: everything up to 2.1 (no version field on disk).
 * 2: CurseForge becomes the default Discover source.
 */
export const SETTINGS_VERSION = 2

export const DEFAULT_JVM_ARGS =
  '-XX:+UnlockExperimentalVMOptions -XX:+UseG1GC -XX:G1NewSizePercent=20 -XX:G1ReservePercent=20 -XX:MaxGCPauseMillis=50 -XX:G1HeapRegionSize=32M'

const THEMES: ThemeId[] = ['terra', 'infernum', 'finis', 'tenebrae', 'glacies', 'lux']
const UI_STYLES: UiStyle[] = ['modern', 'classic']
const PROVIDERS: Provider[] = ['curseforge', 'modrinth']
const LAUNCH_MODES: LaunchMode[] = ['direct', 'official']

export function defaultSettings(gameDir: string): Settings {
  return {
    settingsVersion: SETTINGS_VERSION,
    gameDir,
    javaPath: '',
    autoJava: true,
    ramMb: 4096,
    jvmArgs: DEFAULT_JVM_ARGS,
    theme: 'terra',
    uiStyle: 'modern',
    defaultProvider: 'curseforge',
    cfProxyUrl: '',
    cfApiKey: '',
    msClientId: '',
    launchMode: 'direct',
    closeLauncherOnLaunch: false,
    fullscreen: false,
    resolutionWidth: 1280,
    resolutionHeight: 720,
    downloadConcurrency: 16,
    proxyUrl: ''
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function oneOf<T extends string>(value: unknown, allowed: T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback
}

function int(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

const str = (value: unknown, fallback: string): string => (typeof value === 'string' ? value : fallback)
const bool = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback)

/**
 * Coerce every known field to its type and range. Used for both the file on
 * disk and every patch the renderer sends, so a bad value can never be saved.
 * RAM is only bounded loosely here; the main process clamps it to this
 * machine's safe maximum.
 */
export function normalizeSettings(value: Record<string, unknown>, defaults: Settings): Settings {
  const legacyMode = value.launchMode === 'offline' ? 'direct' : value.launchMode
  return {
    ...(value as Partial<Settings>),
    settingsVersion: int(value.settingsVersion, SETTINGS_VERSION, 1, 1_000),
    gameDir: str(value.gameDir, defaults.gameDir).trim() || defaults.gameDir,
    javaPath: str(value.javaPath, defaults.javaPath).trim(),
    autoJava: bool(value.autoJava, defaults.autoJava),
    ramMb: int(value.ramMb, defaults.ramMb, 512, 1_048_576),
    jvmArgs: str(value.jvmArgs, defaults.jvmArgs),
    theme: oneOf(value.theme, THEMES, defaults.theme),
    uiStyle: oneOf(value.uiStyle, UI_STYLES, defaults.uiStyle),
    defaultProvider: oneOf(value.defaultProvider, PROVIDERS, defaults.defaultProvider),
    cfProxyUrl: str(value.cfProxyUrl, '').trim(),
    cfApiKey: str(value.cfApiKey, '').trim(),
    msClientId: str(value.msClientId, '').trim(),
    launchMode: oneOf(legacyMode, LAUNCH_MODES, defaults.launchMode),
    closeLauncherOnLaunch: bool(value.closeLauncherOnLaunch, defaults.closeLauncherOnLaunch),
    fullscreen: bool(value.fullscreen, defaults.fullscreen),
    resolutionWidth: int(value.resolutionWidth, defaults.resolutionWidth, 320, 15_360),
    resolutionHeight: int(value.resolutionHeight, defaults.resolutionHeight, 240, 8_640),
    downloadConcurrency: int(value.downloadConcurrency, defaults.downloadConcurrency, 1, 64),
    proxyUrl: str(value.proxyUrl, '').trim()
  }
}

/**
 * Bring a settings file of any age up to the current schema.
 *
 * `migrated` is true when the result differs from what is on disk in a way
 * worth writing back (a version bump or a repaired field).
 */
export function migrateSettings(raw: unknown, defaults: Settings): { settings: Settings; migrated: boolean } {
  const source: Record<string, unknown> = isRecord(raw) ? { ...raw } : {}
  const fromVersion = typeof source.settingsVersion === 'number' ? source.settingsVersion : 1

  // 1.x kept the direct-auth application id under a different name. It was
  // already retired; drop it rather than carry a second copy.
  delete source.microsoftClientId

  if (fromVersion < 2) {
    // 2: CurseForge is the default source now that release builds carry a key.
    // Any earlier choice predates the change, so it is reset once; a choice
    // made after this point is remembered (the version is 2 from then on).
    source.defaultProvider = 'curseforge'
  }
  source.settingsVersion = Math.max(fromVersion, SETTINGS_VERSION)

  const settings = normalizeSettings(source, defaults)
  const migrated = !isRecord(raw) || JSON.stringify(settings) !== JSON.stringify(raw)
  return { settings, migrated }
}

/** Apply a renderer patch on top of the current settings, normalized. */
export function applySettingsPatch(current: Settings, patch: unknown, defaults: Settings): Settings {
  const safePatch = isRecord(patch) ? { ...patch } : {}
  // The version is the file's, never the renderer's to set.
  delete safePatch.settingsVersion
  return normalizeSettings({ ...current, ...safePatch }, defaults)
}

/**
 * The source Discover actually opens on: the saved choice, except that
 * CurseForge falls back to Modrinth when no CurseForge access is configured
 * (a build without a key, no user key, no proxy).
 */
export function effectiveProvider(saved: Provider | undefined, curseforgeAvailable: boolean): Provider {
  if (saved === 'modrinth') return 'modrinth'
  return curseforgeAvailable ? 'curseforge' : 'modrinth'
}
