import { app } from 'electron'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { Instance, Settings } from '@shared/types'
import { defaultGameDir } from './paths'
import { defaultSettings as sharedDefaults, migrateSettings } from '../../shared/settings'

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
  return sharedDefaults(defaultGameDir())
}

/** Read settings.json, migrating an older file forward and writing it back once. */
export function loadSettings(): Settings {
  let raw: unknown = undefined
  try {
    const p = configPath('settings.json')
    if (existsSync(p)) raw = JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    raw = undefined // corrupt file: start from defaults rather than refuse to open
  }
  const { settings, migrated } = migrateSettings(raw, defaultSettings())
  if (migrated && raw !== undefined) {
    try {
      saveSettings(settings)
    } catch {
      /* read-only profile: keep running on the migrated copy in memory */
    }
  }
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
