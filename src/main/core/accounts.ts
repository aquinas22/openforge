import { app, safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AccountSummary, StoredAccount } from '@shared/types'
import { offlineUuid } from './auth'
import { MICROSOFT_SIGN_IN_ENABLED } from './features'
import {
  authenticateMinecraft,
  MicrosoftAuthError,
  refreshTokens,
  type MinecraftSession,
  type MicrosoftTokens
} from './msauth'

/**
 * The account book: offline profiles and signed-in Microsoft accounts.
 *
 * Tokens never touch disk in the clear. Electron's `safeStorage` binds them to
 * the OS keychain (DPAPI on Windows), so a copied accounts.json is useless on
 * another machine. Where the platform offers no encryption we refuse to persist
 * the refresh token at all and ask the player to sign in again next session,
 * which is the honest trade rather than writing a credential in plain text.
 */

interface AccountRecord extends StoredAccount {
  /** Base64 safeStorage blob of the Microsoft refresh token. */
  refreshToken?: string
  /** Base64 safeStorage blob of the current Minecraft access token. */
  minecraftToken?: string
  /** Set when a refresh failed and the player must sign in again. */
  needsReauth?: boolean
}

interface AccountsFile {
  activeId: string | null
  accounts: AccountRecord[]
}

const FILE = 'accounts.json'

function filePath(): string {
  return join(app.getPath('userData'), FILE)
}

function encrypt(value: string): string | undefined {
  try {
    if (!safeStorage.isEncryptionAvailable()) return undefined
    return safeStorage.encryptString(value).toString('base64')
  } catch {
    return undefined
  }
}

function decrypt(value: string | undefined): string | null {
  if (!value) return null
  try {
    if (!safeStorage.isEncryptionAvailable()) return null
    return safeStorage.decryptString(Buffer.from(value, 'base64'))
  } catch {
    return null
  }
}

function read(): AccountsFile {
  try {
    const raw = JSON.parse(readFileSync(filePath(), 'utf8')) as AccountsFile
    return { activeId: raw.activeId ?? null, accounts: Array.isArray(raw.accounts) ? raw.accounts : [] }
  } catch {
    return { activeId: null, accounts: [] }
  }
}

function write(data: AccountsFile): void {
  const dir = app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(filePath(), JSON.stringify(data, null, 2), 'utf8')
}

/** What the launcher actually passes to the JVM. */
export interface LaunchAccount {
  username: string
  uuid: string
  accessToken: string
  /** "msa" unlocks online play; "legacy" is the offline placeholder. */
  userType: 'msa' | 'legacy'
  xuid: string
  clientId: string
}

export class AccountStore {
  private data: AccountsFile

  constructor() {
    this.data = read()
  }

  /** Whether tokens can be stored at rest on this machine. */
  get encryptionAvailable(): boolean {
    try {
      return safeStorage.isEncryptionAvailable()
    } catch {
      return false
    }
  }

  private persist(): void {
    write(this.data)
  }

  /**
   * Accounts the launcher can use right now. While Microsoft sign-in is off,
   * saved Microsoft accounts stay in the file but are not offered.
   */
  private usable(): AccountRecord[] {
    return MICROSOFT_SIGN_IN_ENABLED
      ? this.data.accounts
      : this.data.accounts.filter((account) => account.kind !== 'microsoft')
  }

  list(): AccountSummary[] {
    return this.usable().map((account) => ({
      id: account.id,
      kind: account.kind,
      username: account.username,
      uuid: account.uuid,
      xuid: account.xuid,
      expiresAt: account.expiresAt,
      entitled: account.entitled,
      avatarUrl: account.avatarUrl,
      addedAt: account.addedAt,
      active: account.id === this.data.activeId,
      needsReauth: account.needsReauth
    }))
  }

  active(): AccountSummary | null {
    return this.list().find((account) => account.active) ?? null
  }

  private find(id: string): AccountRecord {
    const account = this.usable().find((entry) => entry.id === id)
    if (!account) throw new Error('Account not found.')
    return account
  }

  setActive(id: string): AccountSummary {
    this.find(id)
    this.data.activeId = id
    this.persist()
    return this.active() as AccountSummary
  }

  remove(id: string): void {
    this.find(id)
    this.data.accounts = this.data.accounts.filter((account) => account.id !== id)
    if (this.data.activeId === id) this.data.activeId = this.usable()[0]?.id ?? null
    this.persist()
  }

  /**
   * Add (or rename to) an offline profile. Offline identities are keyed by the
   * deterministic UUID vanilla derives from the name, so re-adding the same
   * name lands on the same worlds rather than creating a stranger.
   */
  addOffline(username: string): AccountSummary {
    const clean = username.trim() || 'Player'
    const uuid = offlineUuid(clean)
    const existing = this.data.accounts.find(
      (account) => account.kind === 'offline' && account.uuid === uuid
    )
    const record: AccountRecord = existing ?? {
      id: randomUUID(),
      kind: 'offline',
      username: clean,
      uuid,
      addedAt: new Date().toISOString()
    }
    record.username = clean
    if (!existing) this.data.accounts.push(record)
    this.data.activeId = record.id
    this.persist()
    return this.active() as AccountSummary
  }

  /** Store a completed Microsoft sign-in and make it the active account. */
  addMicrosoft(session: MinecraftSession, tokens: MicrosoftTokens): AccountSummary {
    const existing = this.data.accounts.find(
      (account) => account.kind === 'microsoft' && account.uuid === session.uuid
    )
    const record: AccountRecord = existing ?? {
      id: randomUUID(),
      kind: 'microsoft',
      username: session.username,
      uuid: session.uuid,
      addedAt: new Date().toISOString()
    }
    record.username = session.username
    record.uuid = session.uuid
    record.xuid = session.xuid
    record.entitled = session.entitled
    record.avatarUrl = session.avatarUrl
    record.expiresAt = session.expiresAt
    record.refreshToken = encrypt(tokens.refreshToken)
    record.minecraftToken = encrypt(session.accessToken)
    record.needsReauth = false
    if (!existing) this.data.accounts.push(record)
    this.data.activeId = record.id
    this.persist()
    return this.active() as AccountSummary
  }

  /**
   * Produce launch credentials for an account, silently refreshing an expired
   * Microsoft session on the way. Offline accounts hand back the placeholder
   * token vanilla uses when it is not talking to session servers.
   */
  async resolveForLaunch(id: string, msClientId: string): Promise<LaunchAccount> {
    const account = this.find(id)
    if (account.kind === 'microsoft' && !MICROSOFT_SIGN_IN_ENABLED) {
      throw new MicrosoftAuthError('Microsoft sign-in is not available in this version.', 'disabled')
    }
    if (account.kind === 'offline') {
      return {
        username: account.username,
        uuid: account.uuid,
        accessToken: '0',
        userType: 'legacy',
        xuid: '',
        clientId: ''
      }
    }

    // A minute of headroom: a token that expires mid-handshake is as bad as an
    // expired one.
    const stillValid = (account.expiresAt ?? 0) > Date.now() + 60_000
    const cached = decrypt(account.minecraftToken)
    if (stillValid && cached) {
      return {
        username: account.username,
        uuid: account.uuid,
        accessToken: cached,
        userType: 'msa',
        xuid: account.xuid ?? '',
        clientId: account.id
      }
    }

    const refresh = decrypt(account.refreshToken)
    if (!refresh) {
      account.needsReauth = true
      this.persist()
      throw new MicrosoftAuthError(
        `${account.username} needs to sign in to Microsoft again.`,
        'reauth_required'
      )
    }

    try {
      const tokens = await refreshTokens(msClientId, refresh)
      const session = await authenticateMinecraft(tokens.accessToken)
      this.addMicrosoft(session, tokens)
      return {
        username: session.username,
        uuid: session.uuid,
        accessToken: session.accessToken,
        userType: 'msa',
        xuid: session.xuid,
        clientId: account.id
      }
    } catch (err) {
      account.needsReauth = true
      this.persist()
      throw new MicrosoftAuthError(
        `${account.username} needs to sign in to Microsoft again. (${(err as Error).message})`,
        'reauth_required'
      )
    }
  }

  /**
   * Fold a pre-2.0 single-username config into the account book, so upgrading
   * does not silently lose the player's identity (and their worlds with it).
   */
  migrateLegacyUsername(username: string): void {
    if (this.data.accounts.length > 0) {
      // Someone whose active account was Microsoft lands on an offline profile
      // (if they have one) rather than on "no account".
      if (!this.active() && this.usable()[0]) {
        this.data.activeId = this.usable()[0].id
        this.persist()
      }
      return
    }
    this.addOffline(username || 'Player')
  }
}
