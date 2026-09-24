import { randomBytes } from 'node:crypto'

/**
 * Light obfuscation for the CurseForge key that release builds embed.
 *
 * This is NOT encryption. Anything the app can decode, a determined person with
 * the app can decode too - the same trade-off every launcher that ships a
 * CurseForge key makes (Prism Launcher does it this way). The point is only
 * that the key is not a plain-text string sitting in app.asar for a `strings`
 * scan or a casual search to pick up.
 *
 * Format: base64( pad || (key XOR pad) ), with a fresh random pad per build.
 */
export function encodeKeyBlob(key: string, pad: Buffer = randomBytes(Buffer.byteLength(key, 'utf8'))): string {
  const plain = Buffer.from(key, 'utf8')
  if (plain.length === 0) return ''
  if (pad.length !== plain.length) throw new Error('pad length must match the key length')
  const mixed = Buffer.alloc(plain.length)
  for (let i = 0; i < plain.length; i++) mixed[i] = plain[i] ^ pad[i]
  return Buffer.concat([pad, mixed]).toString('base64')
}

export function decodeKeyBlob(blob: string): string {
  if (!blob) return ''
  const raw = Buffer.from(blob, 'base64')
  if (raw.length === 0 || raw.length % 2 !== 0) return ''
  const half = raw.length / 2
  const out = Buffer.alloc(half)
  for (let i = 0; i < half; i++) out[i] = raw[i] ^ raw[half + i]
  return out.toString('utf8')
}

export type CfMode = 'proxy' | 'direct' | 'builtin' | 'none'

/**
 * Which CurseForge credential wins. The user's own choices always beat the
 * build's: a proxy URL, then the user's own key, then the built-in key.
 */
export function resolveCfCredentials(
  proxyUrl: string,
  userKey: string,
  builtinKey: string
): { proxyUrl: string; apiKey: string; mode: CfMode } {
  const proxy = (proxyUrl ?? '').trim().replace(/\/$/, '')
  const own = (userKey ?? '').trim()
  const builtin = (builtinKey ?? '').trim()
  if (proxy) return { proxyUrl: proxy, apiKey: '', mode: 'proxy' }
  if (own) return { proxyUrl: '', apiKey: own, mode: 'direct' }
  if (builtin) return { proxyUrl: '', apiKey: builtin, mode: 'builtin' }
  return { proxyUrl: '', apiKey: '', mode: 'none' }
}
