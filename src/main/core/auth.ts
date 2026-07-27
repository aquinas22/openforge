import { createHash } from 'node:crypto'
import type { Account } from '@shared/types'

/**
 * Produce the same offline UUID vanilla Minecraft uses:
 *   UUID.nameUUIDFromBytes(("OfflinePlayer:" + name).getBytes(UTF_8))
 * which is an RFC-4122 version-3 (MD5) UUID. Deterministic per username so a
 * player keeps the same identity (and world data) across sessions.
 */
export function offlineUuid(username: string): string {
  const hash = createHash('md5').update(`OfflinePlayer:${username}`, 'utf8').digest()
  // Set version (3) and IETF variant bits, matching java.util.UUID.
  hash[6] = (hash[6] & 0x0f) | 0x30
  hash[8] = (hash[8] & 0x3f) | 0x80
  const hex = hash.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** UUID without dashes — the form Minecraft's game args expect. */
export function undashUuid(uuid: string): string {
  return uuid.replace(/-/g, '')
}

const VALID_NAME = /^[A-Za-z0-9_]{1,16}$/

export function isValidUsername(name: string): boolean {
  return VALID_NAME.test(name)
}

export function makeOfflineAccount(username: string): Account {
  const clean = username.trim()
  return { username: clean, uuid: offlineUuid(clean), type: 'offline' }
}
