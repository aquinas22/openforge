import { app } from 'electron'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { Instance, Settings } from '@shared/types'
import { defaultGameDir } from './paths'

/**
 * Tiny JSON-file store for settings, instances, and the active account.
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
    ramMb: 4096,
    jvmArgs:
      '-XX:+UnlockExperimentalVMOptions -XX:+UseG1GC -XX:G1NewSizePercent=20 -XX:G1ReservePercent=20 -XX:MaxGCPauseMillis=50 -XX:G1HeapRegionSize=32M',
    theme: 'terra',
    uiStyle: 'modern',
    cfProxyUrl: '',
    cfApiKey: '',
    launchMode: 'official',
    closeLauncherOnLaunch: false,
    fullscreen: false,
    resolutionWidth: 1280,
    resolutionHeight: 720
  }
}

export function loadSettings(): Settings {
  const settings = readJson<Settings>('settings.json', defaultSettings())
  // Strip the retired direct-auth application ID from older settings files.
  delete (settings as Settings & { microsoftClientId?: string }).microsoftClientId
  return settings
}

export function saveSettings(s: Settings): void {
  writeJson('settings.json', s)
}

export function loadInstances(): Instance[] {
  const data = readJson<{ instances: Instance[] }>('instances.json', { instances: [] })
  return Array.isArray(data.instances) ? data.instances : []
}

export function saveInstances(instances: Instance[]): void {
  writeJson('instances.json', { instances })
}

export function loadUsername(): string {
  return readJson<{ username: string }>('account.json', { username: 'Player' }).username
}

export function saveUsername(username: string): void {
  writeJson('account.json', { username })
}
