import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { createWriteStream, existsSync, statSync } from 'node:fs'
import { mkdir, readFile, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/** Sent on every outbound request. Modrinth's API requires an identifying agent. */
export const USER_AGENT = 'Openforge/2.0.0 (github.com/noahroe/openforge)'

export interface DownloadTask {
  url: string
  dest: string
  sha1?: string
  sha256?: string
  sha512?: string
  size?: number
  headers?: Record<string, string>
  /** Mirrors tried in order when `url` fails. Modrinth packs list several. */
  mirrors?: string[]
}

/** An HTTP request that returned a non-2xx status. Carries the code so callers
 *  can translate specific failures (e.g. 401/403) into actionable messages. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body = ''
  ) {
    super(`HTTP ${status} for ${url}${body ? ` — ${body}` : ''}`)
    this.name = 'HttpError'
  }

  /** 4xx (other than rate limiting) will never succeed on a retry. */
  get permanent(): boolean {
    return this.status !== 429 && this.status >= 400 && this.status < 500
  }
}

/**
 * A TLS failure caused by the machine's network rather than the remote service —
 * corporate/school HTTPS inspection presenting a certificate we cannot verify.
 * Worth its own type because the fix is configuration, not a retry.
 */
export class TlsInterceptionError extends Error {
  constructor(
    readonly url: string,
    readonly detail: string
  ) {
    super(
      `Could not establish a trusted HTTPS connection to ${hostOf(url)}. ` +
        'Something on this network is intercepting the connection with a certificate this computer does not trust. ' +
        'If this is a school or work network, install their root certificate into the Windows trusted-root store ' +
        '(Settings -> Network explains it); otherwise try a different network. ' +
        `(${detail})`
    )
    this.name = 'TlsInterceptionError'
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

const TLS_HINTS = [
  'unable to get local issuer certificate',
  'self signed certificate',
  'self-signed certificate',
  'ERR_CERT_AUTHORITY_INVALID',
  'ERR_CERT_COMMON_NAME_INVALID',
  'ERR_CERT_DATE_INVALID',
  'ERR_SSL_PROTOCOL_ERROR',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
]

function asTlsError(err: unknown, url: string): TlsInterceptionError | null {
  const text = `${(err as Error)?.message ?? ''} ${(err as { cause?: Error })?.cause?.message ?? ''}`
  const hit = TLS_HINTS.find((hint) => text.includes(hint))
  return hit ? new TlsInterceptionError(url, hit) : null
}

// -- Transport ---------------------------------------------------------------
// Electron's `net.fetch` runs on Chromium's network stack, so it honours the
// Windows certificate store, enterprise root CAs, and the system proxy (incl.
// PAC scripts) -- none of which Node's built-in fetch knows about. We resolve it
// lazily and keep a plain-fetch fallback so the core stays usable from scripts.

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

let transport: FetchFn | null = null

function resolveTransport(): FetchFn {
  if (transport) return transport
  try {
    // `electron` is absent when the core runs under plain Node (smoke tests).
    // The bundle is ESM, so reach for it through a CJS require shim.
    const electron = createRequire(import.meta.url)('electron') as { net?: { fetch?: FetchFn } }
    if (typeof electron?.net?.fetch === 'function') {
      transport = electron.net.fetch.bind(electron.net)
      return transport
    }
  } catch {
    /* not running inside Electron */
  }
  transport = ((url, init) => globalThis.fetch(url, init)) as FetchFn
  return transport
}

/** Override the transport (used by the smoke script and tests). */
export function setTransport(fn: FetchFn | null): void {
  transport = fn
}

async function request(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const { timeoutMs = 30_000, ...rest } = init
  const headers = { 'User-Agent': USER_AGENT, ...(rest.headers as Record<string, string> | undefined) }
  try {
    return await resolveTransport()(url, {
      ...rest,
      headers,
      signal: rest.signal ?? AbortSignal.timeout(timeoutMs)
    })
  } catch (err) {
    const tls = asTlsError(err, url)
    if (tls) throw tls
    throw err
  }
}

/** Build an HttpError including a snippet of the server's explanation. */
async function httpError(res: Response, url: string): Promise<HttpError> {
  const body = await res.text().catch(() => '')
  return new HttpError(res.status, url, body.trim().slice(0, 200))
}

async function hashFile(path: string, algorithm: 'sha1' | 'sha256' | 'sha512'): Promise<string> {
  const buf = await readFile(path)
  return createHash(algorithm).update(buf).digest('hex')
}

/** True when the file exists and (if a hash/size is known) already matches. */
async function isValid(task: DownloadTask): Promise<boolean> {
  if (!existsSync(task.dest)) return false
  if (task.sha512) return (await hashFile(task.dest, 'sha512')) === task.sha512.toLowerCase()
  if (task.sha256) return (await hashFile(task.dest, 'sha256')) === task.sha256.toLowerCase()
  if (task.sha1) return (await hashFile(task.dest, 'sha1')) === task.sha1.toLowerCase()
  if (task.size) return statSync(task.dest).size === task.size
  return true
}

async function verify(task: DownloadTask, path: string): Promise<void> {
  if (task.sha512) {
    const got = await hashFile(path, 'sha512')
    if (got !== task.sha512.toLowerCase()) throw new Error(`sha512 mismatch for ${task.dest}`)
  }
  if (task.sha256) {
    const got = await hashFile(path, 'sha256')
    if (got !== task.sha256.toLowerCase()) throw new Error(`sha256 mismatch for ${task.dest}`)
  }
  if (task.sha1) {
    const got = await hashFile(path, 'sha1')
    if (got !== task.sha1.toLowerCase()) {
      throw new Error(`sha1 mismatch for ${task.dest}: expected ${task.sha1}, got ${got}`)
    }
  }
}

/**
 * Fetch one file to disk.
 *
 * The bytes land in a sibling `.part` file and are only renamed into place once
 * the download completed and any declared hash matched. A killed launcher or a
 * dropped connection therefore never leaves a truncated jar that later looks
 * valid -- the failure mode behind the most baffling modpack crashes.
 */
export async function downloadFile(task: DownloadTask, attempts = 4): Promise<void> {
  if (await isValid(task)) return
  await mkdir(dirname(task.dest), { recursive: true })
  const partial = `${task.dest}.part`
  const urls = [task.url, ...(task.mirrors ?? [])].filter(Boolean)

  let lastErr: unknown
  for (const url of urls) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const res = await request(url, { headers: task.headers, timeoutMs: 180_000 })
        if (!res.ok || !res.body) throw await httpError(res, url)
        await pipeline(Readable.fromWeb(res.body as never), createWriteStream(partial))
        await verify(task, partial)
        await rename(partial, task.dest)
        return
      } catch (err) {
        lastErr = err
        await rm(partial, { force: true }).catch(() => undefined)
        // A TLS interception error is a network problem no retry can fix, and a
        // 404/403 on a CDN file will never resolve itself.
        if (err instanceof TlsInterceptionError) throw err
        if (err instanceof HttpError && err.permanent) break
        if (attempt < attempts) await new Promise((r) => setTimeout(r, 500 * attempt))
      }
    }
  }
  throw new Error(`Failed to download ${task.url}: ${(lastErr as Error)?.message ?? 'unknown'}`)
}

export async function getJson<T = unknown>(url: string, headers?: Record<string, string>): Promise<T> {
  const res = await request(url, { headers: { Accept: 'application/json', ...headers } })
  if (!res.ok) throw await httpError(res, url)
  return (await res.json()) as T
}

export async function postJson<T = unknown>(
  url: string,
  body: unknown,
  headers?: Record<string, string>
): Promise<T> {
  const res = await request(url, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body)
  })
  if (!res.ok) throw await httpError(res, url)
  return (await res.json()) as T
}

/** POST a form body -- the shape Microsoft's identity endpoints expect. */
export async function postForm<T = unknown>(url: string, form: Record<string, string>): Promise<T> {
  const res = await request(url, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString()
  })
  if (!res.ok) throw await httpError(res, url)
  return (await res.json()) as T
}

export async function getBuffer(url: string, headers?: Record<string, string>): Promise<Buffer> {
  const res = await request(url, { headers, timeoutMs: 120_000 })
  if (!res.ok) throw await httpError(res, url)
  return Buffer.from(await res.arrayBuffer())
}

export async function getText(url: string, headers?: Record<string, string>): Promise<string> {
  const res = await request(url, { headers })
  if (!res.ok) throw await httpError(res, url)
  return res.text()
}

/** A single reachability probe, used by the in-app network diagnostics. */
export async function probeUrl(url: string): Promise<{ ok: boolean; status?: number; error?: string }> {
  try {
    const res = await request(url, { timeoutMs: 12_000 })
    return { ok: res.ok, status: res.status }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/**
 * Download many files with a bounded worker pool, reporting overall progress as
 * completed/total. Rejects if any single file ultimately fails.
 */
export async function downloadAll(
  tasks: DownloadTask[],
  concurrency: number,
  onProgress?: (completed: number, total: number) => void
): Promise<void> {
  const total = tasks.length
  let completed = 0
  let cursor = 0
  onProgress?.(0, total)

  async function worker(): Promise<void> {
    while (cursor < tasks.length) {
      const task = tasks[cursor++]
      await downloadFile(task)
      completed++
      onProgress?.(completed, total)
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, Math.max(total, 1)) }, () => worker())
  await Promise.all(workers)
}

/**
 * Like `downloadAll`, but a file that ultimately fails is reported instead of
 * aborting the batch. Large modpacks routinely contain one or two files whose
 * CDN entry has rotted; losing the whole install over them is the wrong trade.
 */
export async function downloadAllSettled(
  tasks: DownloadTask[],
  concurrency: number,
  onProgress?: (completed: number, total: number) => void
): Promise<{ failed: { task: DownloadTask; error: Error }[] }> {
  const total = tasks.length
  const failed: { task: DownloadTask; error: Error }[] = []
  let completed = 0
  let cursor = 0
  onProgress?.(0, total)

  async function worker(): Promise<void> {
    while (cursor < tasks.length) {
      const task = tasks[cursor++]
      try {
        await downloadFile(task)
      } catch (err) {
        failed.push({ task, error: err as Error })
      }
      completed++
      onProgress?.(completed, total)
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(total, 1)) }, () => worker()))
  return { failed }
}
