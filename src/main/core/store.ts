import { app } from 'electron'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { Instance, Settings } from '@shared/types'
import { defaultGameDir } from './paths'

/**
 * Tiny JSON-file store for settings and instances.
 * Kept dependency-free and synchronous — the payloads are small and this runs
 * only in the main process at startup and on explicit saves.
 */

function configPath(name: string): string {
  return join(app.getPath('userData'), name)
}

function readJson<T>(name: string, fallback: T): T {
  try {
    const p = configPath(name)
    if (!existsSync(p)) return fallback
    return { ...fallback, ...JSON.parse(readFileSync(p, 'utf8')) }
  } catch {
    return fallback
  }
}

function writeJson(name: string, data: unknown): void {
  const dir = app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(configPath(name), JSON.stringify(data, null, 2), 'utf8')
}

export function defaultSettings(): Settings {
  return {
    gameDir: defaultGameDir(),
    javaPath: '',
    autoJava: true,
    ramMb: 4096,
    jvmArgs:
      '-XX:+UnlockExperimentalVMOptions -XX:+UseG1GC -XX:G1NewSizePercent=20 -XX:G1ReservePercent=20 -XX:MaxGCPauseMillis=50 -XX:G1HeapRegionSize=32M',
    theme: 'terra',
    uiStyle: 'modern',
    defaultProvider: 'modrinth',
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

export function loadSettings(): Settings {
  const settings = readJson<Settings>('settings.json', defaultSettings())
  // Strip the retired direct-auth application ID from older settings files.
  delete (settings as Settings & { microsoftClientId?: string }).microsoftClientId
  // 1.x called the direct launch path "offline", because that was the only
  // identity it could launch with. It now covers Microsoft accounts too.
  if ((settings.launchMode as string) === 'offline') settings.launchMode = 'direct'
  return settings
}

export function saveSettings(s: Settings): void {
  writeJson('settings.json', s)
}

export function loadInstances(): Instance[] {
  const data = readJson<{ instances: Instance[] }>('instances.json', { instances: [] })
  if (!Array.isArray(data.instances)) return []
  // Fold 1.x CurseForge instances onto the provider-neutral fields.
  return data.instances.map((instance) => {
    if (!instance.provider && instance.cfProjectId) {
      return {
        ...instance,
        provider: 'curseforge' as const,
        projectId: String(instance.cfProjectId),
        versionId: instance.cfFileId ? String(instance.cfFileId) : undefined
      }
    }
    return instance
  })
}

export function saveInstances(instances: Instance[]): void {
  writeJson('instances.json', { instances })
}

/** 1.x stored a single offline username; 2.0 has a full account book. */
export function loadLegacyUsername(): string {
  return readJson<{ username: string }>('account.json', { username: 'Player' }).username
}
