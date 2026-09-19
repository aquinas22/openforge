import { createHash } from 'node:crypto'
import type { OfflineAccount } from '@shared/types'

/** Produce the same deterministic offline UUID as vanilla Minecraft. */
export function offlineUuid(username: string): string {
  const hash = createHash('md5').update(`OfflinePlayer:${username}`, 'utf8').digest()
  hash[6] = (hash[6] & 0x0f) | 0x30
  hash[8] = (hash[8] & 0x3f) | 0x80
  const hex = hash.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function undashUuid(uuid: string): string {
  return uuid.replace(/-/g, '')
}

const VALID_NAME = /^[A-Za-z0-9_]{1,16}$/

export function isValidUsername(name: string): boolean {
  return VALID_NAME.test(name)
}

export function makeOfflineAccount(username: string): OfflineAccount {
  const clean = username.trim()
  return { username: clean, uuid: offlineUuid(clean), type: 'offline' }
}
