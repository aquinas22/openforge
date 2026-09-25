import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Who may play offline.
 *
 * Openforge launches the game with an offline identity (username + UUID
 * derived from it), which needs no Microsoft sign-in. A public launcher that
 * did that with no check at all would let anyone play without buying the game.
 * So offline launch is allowed only when this PC's official Minecraft Launcher
 * has at least one signed-in account with a Java Edition profile - the same
 * evidence of a purchase the official launcher itself relies on.
 *
 * The whole policy is `checkOfflinePlayAllowed`. To move to real Microsoft
 * sign-in later, replace its body with an entitlement check against the
 * signed-in account (see docs/microsoft-auth-plan.md); nothing else depends on
 * how the answer is reached.
 *
 * Privacy: the launcher's account files hold access tokens. They are parsed in
 * memory, only profile names are kept, and nothing read here is ever logged.
 *
 * No Electron imports, so scripts/verify.ts can exercise all of it.
 */

/** The account files the official launcher writes (classic, then Microsoft Store/Xbox app). */
export const LAUNCHER_ACCOUNT_FILES = ['launcher_accounts.json', 'launcher_accounts_microsoft_store.json']

/** Refuse to read anything this large: a real account file is a few kilobytes. */
const MAX_ACCOUNT_FILE_BYTES = 4 * 1024 * 1024

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Count the accounts in a launcher_accounts*.json document that carry a Java
 * Edition profile, and return their in-game names. Tokens, emails, and ids are
 * never returned. Malformed input counts as no accounts.
 */
export function parseLauncherAccounts(json: string): { accounts: number; profileNames: string[] } {
  let data: unknown
  try {
    data = JSON.parse(json)
  } catch {
    return { accounts: 0, profileNames: [] }
  }
  const raw = isRecord(data) ? data.accounts : undefined
  const entries = isRecord(raw) ? Object.values(raw) : Array.isArray(raw) ? raw : []
  const profileNames: string[] = []
  let accounts = 0
  for (const entry of entries) {
    if (!isRecord(entry) || !isRecord(entry.minecraftProfile)) continue
    const name = entry.minecraftProfile.name
    const id = entry.minecraftProfile.id
    const hasName = typeof name === 'string' && name.trim().length > 0
    const hasId = typeof id === 'string' && id.trim().length > 0
    if (!hasName && !hasId) continue
    accounts++
    if (hasName && /^[A-Za-z0-9_]{1,16}$/.test(name as string)) profileNames.push(name as string)
  }
  return { accounts, profileNames: [...new Set(profileNames)] }
}

export interface LauncherAccountScan {
  /** Accounts with a Java Edition profile, across both files. */
  accounts: number
  profileNames: string[]
  /** Which of the account files exist (names only). */
  filesFound: string[]
}

/** Read the official launcher's account files in `minecraftDir`. */
export function scanLauncherAccounts(minecraftDir: string): LauncherAccountScan {
  const result: LauncherAccountScan = { accounts: 0, profileNames: [], filesFound: [] }
  for (const file of LAUNCHER_ACCOUNT_FILES) {
    const path = join(minecraftDir, file)
    try {
      if (!existsSync(path) || statSync(path).size > MAX_ACCOUNT_FILE_BYTES) continue
      result.filesFound.push(file)
      const parsed = parseLauncherAccounts(readFileSync(path, 'utf8'))
      result.accounts += parsed.accounts
      result.profileNames.push(...parsed.profileNames)
    } catch {
      /* unreadable: counts as nothing */
    }
  }
  result.profileNames = [...new Set(result.profileNames)]
  return result
}

export interface OfflineGate {
  allowed: boolean
  /** One kind sentence for the UI. */
  reason: string
  profileNames: string[]
}

/**
 * THE ownership gate for offline play. True when the official Minecraft
 * Launcher on this PC has at least one account with a Java Edition profile.
 */
export function checkOfflinePlayAllowed(minecraftDir: string): OfflineGate {
  const scan = scanLauncherAccounts(minecraftDir)
  if (scan.accounts > 0) {
    const who = scan.profileNames.length ? ` (${scan.profileNames.join(', ')})` : ''
    return {
      allowed: true,
      reason: `Minecraft Launcher account found on this PC${who}.`,
      profileNames: scan.profileNames
    }
  }
  return {
    allowed: false,
    reason: scan.filesFound.length
      ? 'The Minecraft Launcher on this PC has no signed-in account that owns Minecraft: Java Edition yet.'
      : 'No Minecraft Launcher account was found on this PC.',
    profileNames: []
  }
}

export type LauncherKind = 'legacy' | 'store'

export interface LauncherInstall {
  installed: boolean
  kind: LauncherKind | null
  /** The legacy executable, when that is what was found. */
  path?: string
}

/**
 * The Minecraft Launcher's Microsoft Store / Xbox app package family. Store
 * apps live in a protected folder, so the per-user package data folder is what
 * can be checked cheaply; opening it goes through the Start menu entry.
 */
export const STORE_PACKAGE_FAMILY = 'Microsoft.4297127D64EC6_8wekyb3d8bbwe'

/** Where the official launcher may be installed on Windows. `exists` is injectable for tests. */
export function detectLauncherInstall(
  env: Record<string, string | undefined>,
  exists: (path: string) => boolean = existsSync
): LauncherInstall {
  const candidates = [
    env.ProgramFiles && join(env.ProgramFiles, 'Minecraft Launcher', 'MinecraftLauncher.exe'),
    env['ProgramFiles(x86)'] && join(env['ProgramFiles(x86)'], 'Minecraft Launcher', 'MinecraftLauncher.exe'),
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs', 'Minecraft Launcher', 'MinecraftLauncher.exe')
  ].filter((candidate): candidate is string => Boolean(candidate))
  const legacy = candidates.find((path) => exists(path))
  if (legacy) return { installed: true, kind: 'legacy', path: legacy }
  if (env.LOCALAPPDATA && exists(join(env.LOCALAPPDATA, 'Packages', STORE_PACKAGE_FAMILY))) {
    return { installed: true, kind: 'store' }
  }
  return { installed: false, kind: null }
}
