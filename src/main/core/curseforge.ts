import type {
  ContentKind,
  ContentProject,
  ContentSearchResult,
  ContentSort,
  ContentVersion,
  LoaderType
} from '@shared/types'
import { getJson, HttpError, postJson } from './http'

/**
 * CurseForge access with two interchangeable transports:
 *  - proxy: talks to a servercraft-style server that holds the API key
 *    server-side (recommended - no key shipped in the desktop app);
 *  - direct: talks to api.curseforge.com with a user-supplied key.
 *
 * Direct mode also unlocks the bulk endpoints, which matter enormously: a pack
 * like All the Mods lists 400+ files, and resolving those one request at a time
 * turns a 20-second install into a 10-minute one (and invites rate limiting).
 */

const DIRECT_BASE = 'https://api.curseforge.com/v1'
const GAME_ID = 432

export const CLASS_ID: Record<ContentKind, number> = {
  modpack: 4471,
  mod: 6,
  resourcepack: 12,
  shader: 6552,
  datapack: 6945
}

const KIND_BY_CLASS = new Map<number, ContentKind>(
  Object.entries(CLASS_ID).map(([kind, id]) => [id, kind as ContentKind])
)

const SORT_FIELD: Record<ContentSort, number> = {
  popular: 2,
  downloads: 6,
  updated: 3,
  released: 11,
  follows: 2
}

/** CurseForge's modLoaderType enum, used to filter searches by loader. */
const MOD_LOADER_TYPE: Record<string, number> = {
  forge: 1,
  liteloader: 3,
  fabric: 4,
  quilt: 5,
  neoforge: 6
}

export class CfClient {
  private readonly proxyUrl: string
  private readonly apiKey: string

  constructor(proxyUrl: string, apiKey: string) {
    // Trim both: a pasted key with a trailing space/newline produces a malformed
    // `x-api-key` header (403), and a whitespace-only proxy URL would otherwise
    // look "set" and silently win over direct-key mode.
    this.proxyUrl = (proxyUrl ?? '').trim().replace(/\/$/, '')
    this.apiKey = (apiKey ?? '').trim()
  }

  get available(): boolean {
    return Boolean(this.proxyUrl || this.apiKey)
  }

  get mode(): 'proxy' | 'direct' | 'none' {
    return this.proxyUrl ? 'proxy' : this.apiKey ? 'direct' : 'none'
  }

  /** Bulk resolution needs the real API; the proxy exposes no such route. */
  get supportsBulk(): boolean {
    return this.mode === 'direct'
  }

  private get useProxy(): boolean {
    return Boolean(this.proxyUrl)
  }

  private directHeaders(): Record<string, string> {
    return { 'x-api-key': this.apiKey }
  }

  private authError(err: unknown): Error {
    if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
      return new Error(
        `CurseForge rejected the request (HTTP ${err.status}). Your API key is missing or invalid - ` +
          'check it in Settings -> Content providers. Get a free key at console.curseforge.com.'
      )
    }
    return err as Error
  }

  /** Direct (api.curseforge.com) GET with key validation + friendly auth errors. */
  private async directGet<T>(url: string): Promise<T> {
    if (!this.apiKey) {
      throw new Error('No CurseForge API key set. Add your key in Settings -> Content providers.')
    }
    try {
      return await getJson<T>(url, this.directHeaders())
    } catch (err) {
      throw this.authError(err)
    }
  }

  private async directPost<T>(url: string, body: unknown): Promise<T> {
    if (!this.apiKey) {
      throw new Error('No CurseForge API key set. Add your key in Settings -> Content providers.')
    }
    try {
      return await postJson<T>(url, body, this.directHeaders())
    } catch (err) {
      throw this.authError(err)
    }
  }

  async search(opts: {
    query?: string
    page?: number
    pageSize?: number
    sort?: ContentSort
    gameVersion?: string
    loader?: LoaderType | ''
    kind?: ContentKind
  }): Promise<ContentSearchResult> {
    const {
      query = '',
      page = 0,
      pageSize = 20,
      sort = 'popular',
      gameVersion = '',
      loader = '',
      kind = 'modpack'
    } = opts
    const classId = CLASS_ID[kind]

    if (this.useProxy) {
      const url = new URL(`${this.proxyUrl}/api/cf/search`)
      url.searchParams.set('q', query)
      url.searchParams.set('page', String(page))
      url.searchParams.set('sort', sort)
      url.searchParams.set('classId', String(classId))
      url.searchParams.set('type', kind === 'modpack' ? 'modpack' : 'mod')
      if (gameVersion) url.searchParams.set('gameVersion', gameVersion)
      const raw = await getJson<{
        packs: unknown[]
        pagination: { index: number; pageSize: number; resultCount: number; totalCount: number }
      }>(url.toString())
      return {
        hits: raw.packs.map((p) => normalizeProject(p, kind)).filter(Boolean) as ContentProject[],
        total: raw.pagination?.totalCount ?? raw.packs.length,
        offset: (raw.pagination?.index ?? page * pageSize) as number,
        limit: (raw.pagination?.pageSize ?? pageSize) as number
      }
    }

    const url = new URL(`${DIRECT_BASE}/mods/search`)
    url.searchParams.set('gameId', String(GAME_ID))
    url.searchParams.set('classId', String(classId))
    url.searchParams.set('searchFilter', query)
    if (gameVersion) url.searchParams.set('gameVersion', gameVersion)
    if (loader && MOD_LOADER_TYPE[loader]) {
      url.searchParams.set('modLoaderType', String(MOD_LOADER_TYPE[loader]))
    }
    url.searchParams.set('index', String(page * pageSize))
    url.searchParams.set('pageSize', String(pageSize))
    url.searchParams.set('sortField', String(SORT_FIELD[sort]))
    url.searchParams.set('sortOrder', 'desc')
    const raw = await this.directGet<{
      data: unknown[]
      pagination: { index: number; pageSize: number; resultCount: number; totalCount: number }
    }>(url.toString())
    return {
      hits: raw.data.map((m) => normalizeProject(m, kind)).filter(Boolean) as ContentProject[],
      total: raw.pagination?.totalCount ?? raw.data.length,
      offset: raw.pagination?.index ?? page * pageSize,
      limit: raw.pagination?.pageSize ?? pageSize
    }
  }

  async getProject(id: string): Promise<ContentProject> {
    if (this.useProxy) {
      const res = await getJson<{ pack: unknown }>(`${this.proxyUrl}/api/cf/packs/${id}`)
      return normalizeProject(res.pack) as ContentProject
    }
    const raw = await this.directGet<{ data: unknown }>(`${DIRECT_BASE}/mods/${id}`)
    return normalizeProject(raw.data) as ContentProject
  }

  async getVersions(id: string, page = 0, pageSize = 50): Promise<ContentVersion[]> {
    if (this.useProxy) {
      const res = await getJson<{ files: unknown[] }>(
        `${this.proxyUrl}/api/cf/packs/${id}/files?page=${page}&pageSize=${pageSize}`
      )
      return res.files.map((f) => normalizeVersion(f, id)).filter(Boolean) as ContentVersion[]
    }
    const raw = await this.directGet<{ data: unknown[] }>(
      `${DIRECT_BASE}/mods/${id}/files?index=${page * pageSize}&pageSize=${pageSize}`
    )
    return raw.data.map((f) => normalizeVersion(f, id)).filter(Boolean) as ContentVersion[]
  }

  /** Resolve one specific file (name + download url) for a project. */
  async getVersion(projectId: string, versionId: string): Promise<ContentVersion | null> {
    if (this.useProxy) {
      // The proxy has no single-file route, but /files lists them; the target
      // is usually on the first page for a pack's own file.
      for (let page = 0; page < 4; page++) {
        const files = await this.getVersions(projectId, page, 50)
        const hit = files.find((f) => f.id === versionId)
        if (hit) return hit
        if (files.length < 50) break
      }
      return null
    }
    const raw = await this.directGet<{ data: unknown }>(
      `${DIRECT_BASE}/mods/${projectId}/files/${versionId}`
    )
    return normalizeVersion(raw.data)
  }

  /**
   * Resolve up to 1000 file ids per request.
   *
   * This is the difference between a modpack install that takes seconds and one
   * that takes minutes. Falls back to sequential resolution when only a proxy is
   * configured, which has no bulk route.
   */
  async getVersionsBulk(
    refs: { projectId: string; versionId: string }[]
  ): Promise<Map<string, ContentVersion>> {
    const out = new Map<string, ContentVersion>()
    if (refs.length === 0) return out

    if (this.supportsBulk) {
      for (let i = 0; i < refs.length; i += 1000) {
        const slice = refs.slice(i, i + 1000)
        const raw = await this.directPost<{ data: unknown[] }>(`${DIRECT_BASE}/mods/files`, {
          fileIds: slice.map((r) => Number(r.versionId))
        })
        for (const item of raw.data) {
          const version = normalizeVersion(item)
          if (version) out.set(version.id, version)
        }
      }
      return out
    }

    // Proxy fallback: bounded concurrency so we do not hammer the proxy.
    const CHUNK = 8
    for (let i = 0; i < refs.length; i += CHUNK) {
      const slice = refs.slice(i, i + CHUNK)
      const resolved = await Promise.all(
        slice.map((ref) => this.getVersion(ref.projectId, ref.versionId).catch(() => null))
      )
      for (const version of resolved) if (version) out.set(version.id, version)
    }
    return out
  }

  /** Resolve many projects at once, for names and page links. */
  async getProjectsBulk(ids: string[]): Promise<Map<string, ContentProject>> {
    const out = new Map<string, ContentProject>()
    if (ids.length === 0 || !this.supportsBulk) return out
    for (let i = 0; i < ids.length; i += 1000) {
      const slice = ids.slice(i, i + 1000)
      const raw = await this.directPost<{ data: unknown[] }>(`${DIRECT_BASE}/mods`, {
        modIds: slice.map(Number)
      })
      for (const item of raw.data) {
        const project = normalizeProject(item)
        if (project) out.set(project.id, project)
      }
    }
    return out
  }

  /**
   * Ask CurseForge for the authoritative download URL of a file.
   *
   * `downloadUrl` is null for any project whose author disabled third-party
   * distribution in the API listing, but this endpoint still answers for many of
   * them - so consulting it turns a chunk of "couldn't be auto-downloaded" mods
   * into real downloads. Returns null when CurseForge genuinely refuses.
   */
  async getDownloadUrl(projectId: string, versionId: string): Promise<string | null> {
    if (this.useProxy) return null // the proxy exposes no equivalent route
    try {
      const raw = await this.directGet<{ data: string | null }>(
        `${DIRECT_BASE}/mods/${projectId}/files/${versionId}/download-url`
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
  async resolveDownloadUrl(projectId: string, version: ContentVersion): Promise<string> {
    if (version.downloadUrl) return version.downloadUrl
    const official = await this.getDownloadUrl(projectId, version.id)
    return official ?? forgeCdnUrl(Number(version.id), version.fileName)
  }
}

/** CurseForge's public CDN pattern - works without a key for most files. */
export function forgeCdnUrl(fileId: number, fileName: string): string {
  const idStr = String(fileId)
  const first = Number(idStr.slice(0, idStr.length - 3)) // e.g. 4567890 -> 4567
  const last = Number(idStr.slice(idStr.length - 3)) // -> 890
  return `https://mediafilez.forgecdn.net/files/${first}/${last}/${encodeURIComponent(fileName)}`
}

/** Every CDN host CurseForge has served files from, tried in order. */
export function forgeCdnMirrors(fileId: number, fileName: string): string[] {
  const idStr = String(fileId)
  const first = Number(idStr.slice(0, idStr.length - 3))
  const last = Number(idStr.slice(idStr.length - 3))
  const tail = `${first}/${last}/${encodeURIComponent(fileName)}`
  return [`https://edge.forgecdn.net/files/${tail}`, `https://media.forgecdn.net/files/${tail}`]
}

// -- Normalizers --------------------------------------------------------------
// The proxy mirrors these shapes, so both transports converge here.

function normalizeProject(raw: unknown, fallbackKind: ContentKind = 'mod'): ContentProject | null {
  const m = raw as Record<string, any>
  if (!m) return null
  const kind = KIND_BY_CLASS.get(m.classId) ?? fallbackKind
  const gameVersions = new Set<string>()
  const loaders = new Set<string>()
  for (const file of (m.latestFilesIndexes ?? []) as { gameVersion?: string; modLoader?: number }[]) {
    if (file.gameVersion) gameVersions.add(file.gameVersion)
    const loaderName = Object.entries(MOD_LOADER_TYPE).find(([, v]) => v === file.modLoader)?.[0]
    if (loaderName) loaders.add(loaderName)
  }
  return {
    provider: 'curseforge',
    id: String(m.id),
    slug: m.slug ?? String(m.id),
    name: m.name ?? 'Unknown',
    summary: m.summary || '',
    downloads: m.downloadCount || m.downloads || 0,
    iconUrl: m.logo?.thumbnailUrl || m.logo?.url || m.logo || null,
    gallery: ((m.screenshots ?? []) as { url?: string; thumbnailUrl?: string }[])
      .map((s) => s.url || s.thumbnailUrl)
      .filter(Boolean) as string[],
    authors: ((m.authors ?? []) as { name?: string }[]).map((a) => a.name).filter(Boolean) as string[],
    categories: ((m.categories ?? []) as { name?: string }[])
      .map((c) => (typeof c === 'string' ? c : c.name))
      .filter(Boolean) as string[],
    loaders: [...loaders],
    gameVersions: [...gameVersions],
    updatedAt: m.dateModified || m.dateCreated || '',
    kind,
    pageUrl: m.links?.websiteUrl || undefined
  }
}

function normalizeVersion(raw: unknown, projectId?: string): ContentVersion | null {
  const f = raw as Record<string, any>
  if (!f) return null
  const gameVersions: string[] = f.gameVersions || []
  const loaders = gameVersions.filter((v) => /forge|fabric|quilt|neoforge|liteloader/i.test(v))
  const mcVersions = gameVersions.filter(
    (v) => /^\d+\.\d+/.test(v) && !/forge|fabric|quilt|neoforge/i.test(v)
  )
  const rt = f.releaseType
  const sha1 = ((f.hashes ?? []) as { value?: string; algo?: number }[]).find((h) => h.algo === 1)?.value
  const fileId = Number(f.id)
  return {
    provider: 'curseforge',
    id: String(f.id),
    projectId: String(f.modId ?? projectId ?? ''),
    name: f.displayName || f.fileName,
    versionNumber: f.displayName || f.fileName,
    releaseType: rt === 1 ? 'release' : rt === 2 ? 'beta' : rt === 3 ? 'alpha' : 'unknown',
    datePublished: f.fileDate ?? '',
    downloads: f.downloadCount || 0,
    gameVersions: mcVersions,
    loaders,
    fileName: f.fileName,
    fileSize: f.fileLength || 0,
    downloadUrl: f.downloadUrl || null,
    sha1,
    isServerPack: Boolean(f.isServerPack),
    dependencies: ((f.dependencies ?? []) as { modId: number; relationType: number }[])
      // relationType 3 is CurseForge's "required dependency" relation.
      .filter((d) => d.relationType === 3)
      .map((d) => ({ projectId: String(d.modId) })),
    mirrors:
      Number.isFinite(fileId) && f.fileName ? forgeCdnMirrors(fileId, f.fileName) : undefined
  }
}
