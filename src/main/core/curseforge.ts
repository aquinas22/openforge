import type { CfFile, CfMod, CfSearchResult } from '@shared/types'
import { getJson, HttpError } from './http'

const DIRECT_BASE = 'https://api.curseforge.com/v1'
const GAME_ID = 432
export const MODPACK_CLASS = 4471
export const MOD_CLASS = 6

export type CfSort = 'popular' | 'downloads' | 'updated' | 'released'

const SORT_FIELD: Record<CfSort, number> = { popular: 2, downloads: 6, updated: 3, released: 11 }

/**
 * CurseForge access with two interchangeable transports:
 *  - proxy: talks to a servercraft-style server that holds the API key
 *    server-side (recommended — no key shipped in the desktop app);
 *  - direct: talks to api.curseforge.com with a user-supplied key.
 */
export class CfClient {
  private readonly proxyUrl: string
  private readonly apiKey: string

  constructor(proxyUrl: string, apiKey: string) {
    // Trim both: a pasted key with a trailing space/newline produces a malformed
    // `x-api-key` header (403), and a whitespace-only proxy URL would otherwise
    // look "set" and silently win over direct-key mode.
    this.proxyUrl = (proxyUrl ?? '').trim()
    this.apiKey = (apiKey ?? '').trim()
  }

  get available(): boolean {
    return Boolean(this.proxyUrl || this.apiKey)
  }

  private get useProxy(): boolean {
    return Boolean(this.proxyUrl)
  }

  private directHeaders(): Record<string, string> {
    return { 'x-api-key': this.apiKey }
  }

  /** Direct (api.curseforge.com) GET with key validation + friendly auth errors. */
  private async directGet<T>(url: string): Promise<T> {
    if (!this.apiKey) {
      throw new Error('No CurseForge API key set. Add your key in Settings → CurseForge.')
    }
    try {
      return await getJson<T>(url, this.directHeaders())
    } catch (err) {
      if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
        throw new Error(
          'CurseForge rejected the request (HTTP ' +
            err.status +
            '). Your API key is missing or invalid — check it in Settings → CurseForge. ' +
            'Get a free key at console.curseforge.com.'
        )
      }
      throw err
    }
  }

  async search(opts: {
    query?: string
    page?: number
    sort?: CfSort
    gameVersion?: string
    classId?: number
  }): Promise<CfSearchResult> {
    const { query = '', page = 0, sort = 'popular', gameVersion = '', classId = MODPACK_CLASS } = opts
    if (this.useProxy) {
      const url = new URL(this.proxyUrl.replace(/\/$/, '') + '/api/cf/search')
      url.searchParams.set('q', query)
      url.searchParams.set('page', String(page))
      url.searchParams.set('sort', sort)
      url.searchParams.set('classId', String(classId))
      url.searchParams.set('type', classId === MOD_CLASS ? 'mod' : 'modpack')
      if (gameVersion) url.searchParams.set('gameVersion', gameVersion)
      return getJson<CfSearchResult>(url.toString())
    }
    const url = new URL(DIRECT_BASE + '/mods/search')
    url.searchParams.set('gameId', String(GAME_ID))
    url.searchParams.set('classId', String(classId))
    url.searchParams.set('searchFilter', query)
    if (gameVersion) url.searchParams.set('gameVersion', gameVersion)
    url.searchParams.set('index', String(page * 20))
    url.searchParams.set('pageSize', '20')
    url.searchParams.set('sortField', String(SORT_FIELD[sort]))
    url.searchParams.set('sortOrder', 'desc')
    const raw = await this.directGet<{ data: unknown[]; pagination: CfSearchResult['pagination'] }>(
      url.toString()
    )
    return { packs: raw.data.map(normalizeMod).filter(Boolean) as CfMod[], pagination: raw.pagination }
  }

  async getMod(id: number): Promise<CfMod> {
    if (this.useProxy) {
      const res = await getJson<{ pack: CfMod }>(
        this.proxyUrl.replace(/\/$/, '') + `/api/cf/packs/${id}`
      )
      return res.pack
    }
    const raw = await this.directGet<{ data: unknown }>(`${DIRECT_BASE}/mods/${id}`)
    return normalizeMod(raw.data) as CfMod
  }

  async getFiles(id: number, page = 0, pageSize = 50): Promise<CfFile[]> {
    if (this.useProxy) {
      const res = await getJson<{ files: CfFile[] }>(
        this.proxyUrl.replace(/\/$/, '') + `/api/cf/packs/${id}/files?page=${page}&pageSize=${pageSize}`
      )
      return res.files
    }
    const raw = await this.directGet<{ data: unknown[] }>(
      `${DIRECT_BASE}/mods/${id}/files?index=${page * pageSize}&pageSize=${pageSize}`
    )
    return raw.data.map(normalizeFile).filter(Boolean) as CfFile[]
  }

  /** Resolve one specific file (name + download url) for a project. */
  async resolveFile(projectId: number, fileId: number): Promise<CfFile | null> {
    if (this.useProxy) {
      // The proxy has no single-file route, but /files lists them; the target
      // is usually on the first page for a pack's own file.
      for (let page = 0; page < 4; page++) {
        const files = await this.getFiles(projectId, page, 50)
        const hit = files.find((f) => f.id === fileId)
        if (hit) return hit
        if (files.length < 50) break
      }
      return null
    }
    const raw = await this.directGet<{ data: unknown }>(
      `${DIRECT_BASE}/mods/${projectId}/files/${fileId}`
    )
    return normalizeFile(raw.data)
  }

  /**
   * Ask CurseForge for the authoritative download URL of a file.
   *
   * `file.downloadUrl` is null for any project whose author disabled third-party
   * distribution in the API listing, but this endpoint still answers for many of
   * them — so consulting it turns a chunk of "couldn't be auto-downloaded" mods
   * into real downloads. Returns null when CurseForge genuinely refuses.
   */
  async getDownloadUrl(projectId: number, fileId: number): Promise<string | null> {
    if (this.useProxy) return null // the proxy exposes no equivalent route
    try {
      const raw = await this.directGet<{ data: string | null }>(
        `${DIRECT_BASE}/mods/${projectId}/files/${fileId}/download-url`
      )
      return raw.data || null
    } catch {
      return null
    }
  }

  /**
   * Best available URL for a file: what the listing gave us, then the official
   * endpoint, then the predictable CDN path as a last resort.
   */
  async resolveDownloadUrl(
    projectId: number,
    file: Pick<CfFile, 'id' | 'fileName' | 'downloadUrl'>
  ): Promise<string> {
    if (file.downloadUrl) return file.downloadUrl
    const official = await this.getDownloadUrl(projectId, file.id)
    return official ?? forgeCdnUrl(file.id, file.fileName)
  }
}

/** CurseForge's public CDN pattern — works without a key for most files. */
export function forgeCdnUrl(fileId: number, fileName: string): string {
  const idStr = String(fileId)
  const first = Number(idStr.slice(0, idStr.length - 3)) // e.g. 4567890 -> 4567
  const last = Number(idStr.slice(idStr.length - 3)) // -> 890
  return `https://mediafilez.forgecdn.net/files/${first}/${last}/${encodeURIComponent(fileName)}`
}

// Normalizers mirroring the servercraft proxy so both transports return the same shape.

function normalizeMod(m: any): CfMod | null {
  if (!m) return null
  return {
    id: m.id,
    name: m.name,
    slug: m.slug,
    summary: m.summary || '',
    downloadCount: m.downloadCount || 0,
    logo: m.logo?.thumbnailUrl || m.logo?.url || null,
    authors: (m.authors || []).map((a: any) => a.name).filter(Boolean),
    categories: (m.categories || []).map((c: any) => c.name).filter(Boolean),
    dateModified: m.dateModified || m.dateCreated,
    links: m.links || {}
  }
}

function normalizeFile(f: any): CfFile | null {
  if (!f) return null
  const gameVersions: string[] = f.gameVersions || []
  const loaders = gameVersions.filter((v) => /forge|fabric|quilt|neoforge|liteloader/i.test(v))
  const mcVersions = gameVersions.filter((v) => /^\d+\.\d+/.test(v) && !/forge|fabric|quilt|neoforge/i.test(v))
  const rt = f.releaseType
  return {
    id: f.id,
    displayName: f.displayName || f.fileName,
    fileName: f.fileName,
    fileDate: f.fileDate,
    fileLength: f.fileLength || 0,
    downloadCount: f.downloadCount || 0,
    releaseType: rt === 1 ? 'release' : rt === 2 ? 'beta' : rt === 3 ? 'alpha' : 'unknown',
    downloadUrl: f.downloadUrl || null,
    gameVersions: mcVersions,
    loaders,
    isServerPack: Boolean(f.isServerPack),
    serverPackFileId: f.serverPackFileId || null,
    dependencies: f.dependencies || []
  }
}
