import { decodeKeyBlob } from './keyblob'

/**
 * Replaced at build time by electron.vite `define` (main process only) with the
 * obfuscated blob of OPENFORGE_CF_KEY, or with '' when that variable is unset.
 * Builds from source without the variable simply have no built-in key.
 */
declare const __OPENFORGE_CF_KEY_BLOB__: string

let cached: string | undefined

/** The CurseForge key this build ships with, or '' if none. Main process only. */
export function builtinCfKey(): string {
  if (cached === undefined) {
    const blob = typeof __OPENFORGE_CF_KEY_BLOB__ === 'string' ? __OPENFORGE_CF_KEY_BLOB__ : ''
    cached = decodeKeyBlob(blob)
  }
  return cached
}
