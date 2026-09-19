import { getJson, HttpError, postForm, postJson } from './http'

/**
 * Microsoft sign-in for online play, implemented end to end.
 *
 * The chain Mojang requires is: Microsoft identity -> Xbox Live -> XSTS ->
 * Minecraft services. We use the OAuth 2.0 device code flow, which is the right
 * shape for a desktop app: the user finishes sign-in in their own browser and
 * Openforge never sees a password, and there is no embedded webview holding
 * Microsoft credentials.
 *
 * Openforge ships no client id of its own. Microsoft only issues Minecraft
 * sign-in permission to a registered Azure application, so the user supplies one
 * (Settings -> Accounts explains how, and it takes about two minutes). Without
 * it, online play falls back to handing off to the official Minecraft Launcher.
 */

const DEVICE_CODE_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode'
const TOKEN_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token'
const XBL_URL = 'https://user.auth.xboxlive.com/user/authenticate'
const XSTS_URL = 'https://xsts.auth.xboxlive.com/xsts/authorize'
const MC_LOGIN_URL = 'https://api.minecraftservices.com/authentication/login_with_xbox'
const MC_ENTITLEMENTS_URL = 'https://api.minecraftservices.com/entitlements/mcstore'
const MC_PROFILE_URL = 'https://api.minecraftservices.com/minecraft/profile'

const SCOPE = 'XboxLive.signin offline_access'

export interface DeviceCodeStart {
  deviceCode: string
  userCode: string
  verificationUri: string
  expiresIn: number
  interval: number
  message: string
}

export interface MicrosoftTokens {
  accessToken: string
  refreshToken: string
  /** Epoch ms. */
  expiresAt: number
}

export interface MinecraftSession {
  accessToken: string
  /** Epoch ms. */
  expiresAt: number
  uuid: string
  username: string
  xuid: string
  entitled: boolean
  avatarUrl?: string
}

export class MicrosoftAuthError extends Error {
  constructor(
    message: string,
    readonly code?: string
  ) {
    super(message)
    this.name = 'MicrosoftAuthError'
  }
}

function requireClientId(clientId: string): string {
  const trimmed = (clientId ?? '').trim()
  if (!trimmed) {
    throw new MicrosoftAuthError(
      'No Microsoft application id is configured. Add one in Settings -> Accounts, ' +
        'or use the official Minecraft Launcher hand-off for online play.',
      'no_client_id'
    )
  }
  return trimmed
}

/** Step 1: ask Microsoft for a code the user types into microsoft.com/link. */
export async function startDeviceCode(clientId: string): Promise<DeviceCodeStart> {
  const id = requireClientId(clientId)
  const raw = await postForm<{
    device_code: string
    user_code: string
    verification_uri: string
    expires_in: number
    interval: number
    message: string
  }>(DEVICE_CODE_URL, { client_id: id, scope: SCOPE })
  return {
    deviceCode: raw.device_code,
    userCode: raw.user_code,
    verificationUri: raw.verification_uri,
    expiresIn: raw.expires_in,
    interval: Math.max(raw.interval ?? 5, 1),
    message: raw.message
  }
}

interface TokenResponse {
  access_token: string
  refresh_token: string
  expires_in: number
}

function tokensFrom(raw: TokenResponse): MicrosoftTokens {
  return {
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token,
    expiresAt: Date.now() + raw.expires_in * 1000
  }
}

/**
 * Step 2: poll until the user finishes in their browser.
 *
 * Microsoft answers `authorization_pending` until then, and `slow_down` if we
 * poll too eagerly - both are normal and must not be treated as failures.
 */
export async function pollForTokens(
  clientId: string,
  start: DeviceCodeStart,
  opts: { signal?: AbortSignal; onTick?: (secondsLeft: number) => void } = {}
): Promise<MicrosoftTokens> {
  const id = requireClientId(clientId)
  const deadline = Date.now() + start.expiresIn * 1000
  let interval = start.interval

  while (Date.now() < deadline) {
    if (opts.signal?.aborted) throw new MicrosoftAuthError('Sign-in cancelled.', 'cancelled')
    await new Promise((r) => setTimeout(r, interval * 1000))
    opts.onTick?.(Math.max(0, Math.round((deadline - Date.now()) / 1000)))

    try {
      const raw = await postForm<TokenResponse>(TOKEN_URL, {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: id,
        device_code: start.deviceCode
      })
      return tokensFrom(raw)
    } catch (err) {
      const code = errorCodeOf(err)
      if (code === 'authorization_pending') continue
      if (code === 'slow_down') {
        interval += 5
        continue
      }
      if (code === 'expired_token') {
        throw new MicrosoftAuthError('The sign-in code expired. Start again.', code)
      }
      if (code === 'authorization_declined') {
        throw new MicrosoftAuthError('Sign-in was declined.', code)
      }
      throw err
    }
  }
  throw new MicrosoftAuthError('The sign-in code expired. Start again.', 'expired_token')
}

/** Microsoft reports OAuth failures as JSON in the body of a 400. */
function errorCodeOf(err: unknown): string | null {
  if (!(err instanceof HttpError)) return null
  try {
    return (JSON.parse(err.body) as { error?: string }).error ?? null
  } catch {
    return null
  }
}

export async function refreshTokens(clientId: string, refreshToken: string): Promise<MicrosoftTokens> {
  const id = requireClientId(clientId)
  const raw = await postForm<TokenResponse>(TOKEN_URL, {
    grant_type: 'refresh_token',
    client_id: id,
    refresh_token: refreshToken,
    scope: SCOPE
  })
  return tokensFrom(raw)
}

interface XboxResponse {
  Token: string
  DisplayClaims: { xui: { uhs: string; xid?: string }[] }
}

/**
 * Steps 3-6: trade a Microsoft token for a Minecraft session.
 *
 * Each hop has its own failure vocabulary, and the XSTS ones in particular are
 * situations a player can actually fix, so they get their own messages instead
 * of a bare HTTP code.
 */
export async function authenticateMinecraft(microsoftAccessToken: string): Promise<MinecraftSession> {
  const xbl = await postJson<XboxResponse>(XBL_URL, {
    Properties: {
      AuthMethod: 'RPS',
      SiteName: 'user.auth.xboxlive.com',
      RpsTicket: `d=${microsoftAccessToken}`
    },
    RelyingParty: 'http://auth.xboxlive.com',
    TokenType: 'JWT'
  })

  let xsts: XboxResponse
  try {
    xsts = await postJson<XboxResponse>(XSTS_URL, {
      Properties: { SandboxId: 'RETAIL', UserTokens: [xbl.Token] },
      RelyingParty: 'rp://api.minecraftservices.com/',
      TokenType: 'JWT'
    })
  } catch (err) {
    throw translateXstsError(err)
  }

  const userHash = xsts.DisplayClaims?.xui?.[0]?.uhs
  const xuid = xsts.DisplayClaims?.xui?.[0]?.xid ?? ''
  if (!userHash) throw new MicrosoftAuthError('Xbox Live did not return a user hash.')

  const mc = await postJson<{ access_token: string; expires_in: number }>(MC_LOGIN_URL, {
    identityToken: `XBL3.0 x=${userHash};${xsts.Token}`
  })
  const bearer = { Authorization: `Bearer ${mc.access_token}` }

  // An account without an entitlement can sign in but cannot play; say so
  // before the game starts rather than after it fails.
  const entitlements = await getJson<{ items?: { name: string }[] }>(MC_ENTITLEMENTS_URL, bearer)
  const entitled = Boolean(entitlements.items?.length)

  let profile: { id: string; name: string; skins?: { url: string; state: string }[] }
  try {
    profile = await getJson(MC_PROFILE_URL, bearer)
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) {
      throw new MicrosoftAuthError(
        'This Microsoft account does not own Minecraft: Java Edition, or has no Minecraft profile yet. ' +
          'Buy or claim the game (including through Game Pass) and create your profile at minecraft.net first.',
        'no_profile'
      )
    }
    throw err
  }

  return {
    accessToken: mc.access_token,
    expiresAt: Date.now() + mc.expires_in * 1000,
    uuid: dashUuid(profile.id),
    username: profile.name,
    xuid,
    entitled,
    avatarUrl: `https://crafatar.com/avatars/${profile.id}?size=64&overlay`
  }
}

function translateXstsError(err: unknown): Error {
  if (!(err instanceof HttpError)) return err as Error
  let xErr: number | undefined
  try {
    xErr = (JSON.parse(err.body) as { XErr?: number }).XErr
  } catch {
    /* not the documented shape */
  }
  switch (xErr) {
    case 2148916233:
      return new MicrosoftAuthError(
        'This Microsoft account has no Xbox profile. Sign in at xbox.com once to create one, then try again.',
        'no_xbox_account'
      )
    case 2148916235:
      return new MicrosoftAuthError(
        'Xbox Live is not available in this account’s country or region.',
        'region_blocked'
      )
    case 2148916236:
    case 2148916237:
      return new MicrosoftAuthError(
        'This account needs adult verification before it can use Xbox Live.',
        'verification_required'
      )
    case 2148916238:
      return new MicrosoftAuthError(
        'This is a child account. Add it to a Microsoft family group with an adult, then try again.',
        'child_account'
      )
    default:
      return new MicrosoftAuthError(`Xbox Live rejected the sign-in (${err.status}).`, 'xsts_failed')
  }
}

/** Minecraft returns profile ids undashed; the game wants the dashed form. */
export function dashUuid(id: string): string {
  if (id.includes('-')) return id
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`
}
