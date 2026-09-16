import { app } from 'electron'
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { cpSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Product renames move Electron's userData directory. Keep every known former
 * identity here so an Openforge install can adopt settings, instances, worlds,
 * libraries, and assets without forcing a reinstall.
 */
const LEGACY_DIR_NAMES = ['Ars Fodina', 'ars-fodina', 'aurora-launcher']
const MARKER = 'settings.json'

function moveInto(from: string, to: string): void {
  for (const entry of readdirSync(from)) {
    const src = join(from, entry)
    const dest = join(to, entry)
    if (existsSync(dest)) continue // never clobber data already in the new home
    try {
      renameSync(src, dest)
    } catch {
      // Different volume (or a locked handle): fall back to a copy so the user
      // keeps their data even if the original can't be unlinked.
      cpSync(src, dest, { recursive: true })
      try {
        rmSync(src, { recursive: true, force: true })
      } catch {
        /* leave the original behind rather than fail the migration */
      }
    }
  }
}

/** Repoint an absolute gameDir that still refers to the legacy directory. */
function rewriteGameDir(settingsPath: string, legacyRoot: string, newRoot: string): void {
  if (!existsSync(settingsPath)) return
  try {
    const raw = readFileSync(settingsPath, 'utf8')
    const parsed = JSON.parse(raw) as { gameDir?: string }
    if (typeof parsed.gameDir !== 'string' || !parsed.gameDir.startsWith(legacyRoot)) return
    parsed.gameDir = newRoot + parsed.gameDir.slice(legacyRoot.length)
    writeFileSync(settingsPath, JSON.stringify(parsed, null, 2), 'utf8')
  } catch {
    /* unreadable/corrupt settings — the app will fall back to defaults */
  }
}

/**
 * Runs before any config is read. Safe to call on every start: it does nothing
 * once the new directory already holds a settings file.
 */
export function migrateLegacyUserData(log: (msg: string) => void = () => {}): void {
  const newRoot = app.getPath('userData')
  if (existsSync(join(newRoot, MARKER))) return

  for (const directoryName of LEGACY_DIR_NAMES) {
    const legacyRoot = join(app.getPath('appData'), directoryName)
    if (legacyRoot === newRoot || !existsSync(join(legacyRoot, MARKER))) continue

    try {
      log(`Migrating launcher data from ${legacyRoot}`)
      moveInto(legacyRoot, newRoot)
      rewriteGameDir(join(newRoot, MARKER), legacyRoot, newRoot)
      log(`Migration complete — data now lives in ${newRoot}`)
    } catch (err) {
      log(`Migration failed (${(err as Error).message}); existing data left untouched.`)
    }
    return
  }
}

/** Remove credentials created by the retired direct Microsoft auth flow. */
export function removeLegacyAuthCredential(log: (msg: string) => void = () => {}): void {
  const credential = join(app.getPath('userData'), 'microsoft-auth.json')
  if (!existsSync(credential)) return
  try {
    rmSync(credential, { force: true })
    log('Removed legacy Microsoft authentication credential.')
  } catch (err) {
    log(`Could not remove legacy authentication credential: ${(err as Error).message}`)
  }
}
