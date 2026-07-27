import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, statSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export interface DownloadTask {
  url: string
  dest: string
  sha1?: string
  size?: number
  headers?: Record<string, string>
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

/** Build an HttpError including a snippet of the server's explanation. */
async function httpError(res: Response, url: string): Promise<HttpError> {
  const body = await res.text().catch(() => '')
  return new HttpError(res.status, url, body.trim().slice(0, 200))
}

async function sha1OfFile(path: string): Promise<string> {
  const buf = await readFile(path)
  return createHash('sha1').update(buf).digest('hex')
}

/** True when the file exists and (if a hash/size is known) already matches. */
async function isValid(task: DownloadTask): Promise<boolean> {
  if (!existsSync(task.dest)) return false
  if (task.sha1) return (await sha1OfFile(task.dest)) === task.sha1.toLowerCase()
  if (task.size) return statSync(task.dest).size === task.size
  return true
}

export async function downloadFile(task: DownloadTask, attempts = 4): Promise<void> {
  if (await isValid(task)) return
  await mkdir(dirname(task.dest), { recursive: true })

  let lastErr: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(task.url, {
        headers: task.headers,
        signal: AbortSignal.timeout(120_000)
      })
      if (!res.ok || !res.body) {
        throw await httpError(res, task.url)
      }
      await pipeline(Readable.fromWeb(res.body as never), createWriteStream(task.dest))
      if (task.sha1) {
        const got = await sha1OfFile(task.dest)
        if (got !== task.sha1.toLowerCase()) {
          throw new Error(`sha1 mismatch for ${task.dest}: expected ${task.sha1}, got ${got}`)
        }
      }
      return
    } catch (err) {
      lastErr = err
      // A 404/403 on a CDN file will never resolve itself; fail fast instead of
      // spending three more round trips on it.
      if (err instanceof HttpError && err.permanent) break
      if (attempt < attempts) {
        await new Promise((r) => setTimeout(r, 500 * attempt))
      }
    }
  }
  throw new Error(`Failed to download ${task.url}: ${(lastErr as Error)?.message ?? 'unknown'}`)
}

export async function getJson<T = unknown>(
  url: string,
  headers?: Record<string, string>
): Promise<T> {
  const res = await fetch(url, {
    headers: { Accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(30_000)
  })
  if (!res.ok) throw await httpError(res, url)
  return (await res.json()) as T
}

export async function getBuffer(url: string, headers?: Record<string, string>): Promise<Buffer> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(120_000) })
  if (!res.ok) throw await httpError(res, url)
  return Buffer.from(await res.arrayBuffer())
}

export async function getText(url: string, headers?: Record<string, string>): Promise<string> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw await httpError(res, url)
  return res.text()
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
