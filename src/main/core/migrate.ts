import { app } from 'electron'
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { cpSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/**
 * One-time migration from the launcher's previous identity ("Aurora Launcher").
 *
 * Electron derives `userData` from the app name, so renaming the product moves
 * the config directory — which would orphan settings.json, instances.json and,
 * far worse, the default game directory (`<userData>/minecraft`) holding assets,
 * libraries and every instance world. This moves the old tree into place and
 * rewrites the stored absolute `gameDir` so nothing has to be re-downloaded.
 */

const LEGACY_DIR_NAME = 'aurora-launcher'
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
  const legacyRoot = join(app.getPath('appData'), LEGACY_DIR_NAME)

  if (legacyRoot === newRoot) return
  if (!existsSync(legacyRoot)) return
  // Electron may have already created an empty userData dir, so key the check on
  // the marker file rather than directory existence.
  if (existsSync(join(newRoot, MARKER))) return
  if (!existsSync(join(legacyRoot, MARKER))) return

  try {
    log(`Migrating launcher data from ${legacyRoot}`)
    moveInto(legacyRoot, newRoot)
    rewriteGameDir(join(newRoot, MARKER), legacyRoot, newRoot)
    log(`Migration complete — data now lives in ${newRoot}`)
  } catch (err) {
    log(`Migration failed (${(err as Error).message}); existing data left untouched.`)
  }
}
