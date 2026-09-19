import type {
  ContentKind,
  ContentProject,
  ContentSearchResult,
  ContentSort,
  ContentVersion,
  LoaderType
} from '@shared/types'
import { getJson, postJson } from './http'

/**
 * Modrinth v2 client.
 *
 * Modrinth is the launcher's default content source because it needs no API key
 * and no proxy: search, metadata, and the CDN are all open. Everything here
 * normalizes into the provider-neutral `ContentProject` / `ContentVersion`
 * shapes so the UI can show Modrinth and CurseForge results side by side.
 */

const BASE = 'https://api.modrinth.com/v2'

const SORT_INDEX: Record<ContentSort, string> = {
  popular: 'relevance',
  downloads: 'downloads',
  updated: 'updated',
  released: 'newest',
  follows: 'follows'
}

/** Modrinth's project_type vocabulary for each of our content kinds. */
const PROJECT_TYPE: Record<ContentKind, string> = {
  modpack: 'modpack',
  mod: 'mod',
  resourcepack: 'resourcepack',
  shader: 'shader',
  datapack: 'datapack'
}

interface RawHit {
  project_id: string
  slug: string
  title: string
  description: string
  categories?: string[]
  display_categories?: string[]
  downloads?: number
  follows?: number
  icon_url?: string | null
  gallery?: string[]
  author?: string
  versions?: string[]
  date_modified?: string
  project_type?: string
  license?: string
}

interface RawProject {
  id: string
  slug: string
  title: string
  description: string
  body?: string
  categories?: string[]
  loaders?: string[]
  game_versions?: string[]
  downloads?: number
  followers?: number
  icon_url?: string | null
  gallery?: { url: string; featured?: boolean }[]
  updated?: string
  project_type?: string
  team?: string
  license?: { id?: string; name?: string }
}

interface RawVersion {
  id: string
  project_id: string
  name: string
  version_number: string
  changelog?: string | null
  date_published: string
  downloads?: number
  version_type?: string
  game_versions?: string[]
  loaders?: string[]
  dependencies?: { version_id?: string | null; project_id?: string | null; dependency_type: string }[]
  files?: {
    hashes?: { sha1?: string; sha512?: string }
    url: string
    filename: string
    primary?: boolean
    size?: number
  }[]
}

function kindOf(projectType: string | undefined): ContentKind {
  switch (projectType) {
    case 'modpack':
      return 'modpack'
    case 'resourcepack':
      return 'resourcepack'
    case 'shader':
      return 'shader'
    case 'datapack':
      return 'datapack'
    default:
      return 'mod'
  }
}

function releaseTypeOf(versionType: string | undefined): ContentVersion['releaseType'] {
  return versionType === 'release' || versionType === 'beta' || versionType === 'alpha'
    ? versionType
    : 'unknown'
}

/** Categories double as loader tags on Modrinth; split them for display. */
const LOADER_TAGS = new Set([
  'fabric',
  'forge',
  'neoforge',
  'quilt',
  'liteloader',
  'modloader',
  'rift',
  'bukkit',
  'paper',
  'purpur',
  'spigot',
  'sponge',
  'velocity',
  'waterfall',
  'bungeecord',
  'folia',
  'minecraft',
  'iris',
  'optifine',
  'canvas',
  'vanilla'
])

function splitTags(tags: string[]): { loaders: string[]; categories: string[] } {
  const loaders: string[] = []
  const categories: string[] = []
  for (const tag of tags) (LOADER_TAGS.has(tag) ? loaders : categories).push(tag)
  return { loaders, categories }
}

function projectUrl(kind: ContentKind, slug: string): string {
  const segment =
    kind === 'modpack'
      ? 'modpack'
      : kind === 'resourcepack'
        ? 'resourcepack'
        : kind === 'shader'
          ? 'shader'
          : kind === 'datapack'
            ? 'datapack'
            : 'mod'
  return `https://modrinth.com/${segment}/${slug}`
}

function normalizeHit(hit: RawHit): ContentProject {
  const kind = kindOf(hit.project_type)
  const { loaders, categories } = splitTags(hit.display_categories ?? hit.categories ?? [])
  return {
    provider: 'modrinth',
    id: hit.project_id,
    slug: hit.slug,
    name: hit.title,
    summary: hit.description ?? '',
    downloads: hit.downloads ?? 0,
    follows: hit.follows ?? 0,
    iconUrl: hit.icon_url || null,
    gallery: hit.gallery ?? [],
    authors: hit.author ? [hit.author] : [],
    categories,
    loaders,
    gameVersions: hit.versions ?? [],
    updatedAt: hit.date_modified ?? '',
    kind,
    pageUrl: projectUrl(kind, hit.slug)
  }
}

function normalizeProject(project: RawProject): ContentProject {
  const kind = kindOf(project.project_type)
  const { categories } = splitTags(project.categories ?? [])
  return {
    provider: 'modrinth',
    id: project.id,
    slug: project.slug,
    name: project.title,
    summary: project.description ?? '',
    description: project.body ?? undefined,
    downloads: project.downloads ?? 0,
    follows: project.followers ?? 0,
    iconUrl: project.icon_url || null,
    gallery: (project.gallery ?? []).map((g) => g.url),
    authors: [],
    categories,
    loaders: project.loaders ?? [],
    gameVersions: project.game_versions ?? [],
    updatedAt: project.updated ?? '',
    kind,
    pageUrl: projectUrl(kind, project.slug)
  }
}

function normalizeVersion(version: RawVersion): ContentVersion | null {
  const files = version.files ?? []
  // A version can ship several files (e.g. a jar plus its sources); the entry
  // marked primary is the one to install, and the first file is the fallback.
  const file = files.find((f) => f.primary) ?? files[0]
  if (!file) return null
  return {
    provider: 'modrinth',
    id: version.id,
    projectId: version.project_id,
    name: version.name,
    versionNumber: version.version_number,
    releaseType: releaseTypeOf(version.version_type),
    datePublished: version.date_published,
    downloads: version.downloads ?? 0,
    gameVersions: version.game_versions ?? [],
    loaders: version.loaders ?? [],
    fileName: file.filename,
    fileSize: file.size ?? 0,
    downloadUrl: file.url,
    sha1: file.hashes?.sha1,
    sha512: file.hashes?.sha512,
    changelog: version.changelog ?? undefined,
    dependencies: (version.dependencies ?? [])
      .filter((d) => d.dependency_type === 'required' && (d.project_id || d.version_id))
      .map((d) => ({ projectId: d.project_id ?? '', versionId: d.version_id ?? undefined }))
  }
}

export class ModrinthClient {
  /** Modrinth needs no credentials, so this provider is always available. */
  get available(): boolean {
    return true
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

    // Facets are AND-ed across groups and OR-ed within one group.
    const facets: string[][] = [[`project_type:${PROJECT_TYPE[kind]}`]]
    if (gameVersion) facets.push([`versions:${gameVersion}`])
    if (loader && loader !== 'vanilla') facets.push([`categories:${loader}`])

    const url = new URL(`${BASE}/search`)
    if (query) url.searchParams.set('query', query)
    url.searchParams.set('facets', JSON.stringify(facets))
    url.searchParams.set('index', SORT_INDEX[sort] ?? 'relevance')
    url.searchParams.set('offset', String(page * pageSize))
    url.searchParams.set('limit', String(pageSize))

    const raw = await getJson<{ hits: RawHit[]; offset: number; limit: number; total_hits: number }>(
      url.toString()
    )
    return {
      hits: raw.hits.map(normalizeHit),
      total: raw.total_hits,
      offset: raw.offset,
      limit: raw.limit
    }
  }

  async getProject(idOrSlug: string): Promise<ContentProject> {
    const raw = await getJson<RawProject>(`${BASE}/project/${encodeURIComponent(idOrSlug)}`)
    return normalizeProject(raw)
  }

  /** Every published version of a project, newest first, optionally filtered. */
  async getVersions(
    idOrSlug: string,
    filter?: { gameVersion?: string; loader?: string }
  ): Promise<ContentVersion[]> {
    const url = new URL(`${BASE}/project/${encodeURIComponent(idOrSlug)}/version`)
    if (filter?.gameVersion) url.searchParams.set('game_versions', JSON.stringify([filter.gameVersion]))
    if (filter?.loader && filter.loader !== 'vanilla') {
      url.searchParams.set('loaders', JSON.stringify([filter.loader]))
    }
    const raw = await getJson<RawVersion[]>(url.toString())
    return raw
      .map(normalizeVersion)
      .filter((v): v is ContentVersion => v !== null)
      .sort((a, b) => Date.parse(b.datePublished) - Date.parse(a.datePublished))
  }

  async getVersion(versionId: string): Promise<ContentVersion | null> {
    const raw = await getJson<RawVersion>(`${BASE}/version/${encodeURIComponent(versionId)}`)
    return normalizeVersion(raw)
  }

  /**
   * Resolve many versions in one request. Modpack dependency trees and "check
   * for updates" both fan out over hundreds of ids; doing that one-by-one is
   * what makes other launchers feel slow.
   */
  async getVersionsBulk(versionIds: string[]): Promise<ContentVersion[]> {
    const out: ContentVersion[] = []
    for (let i = 0; i < versionIds.length; i += 200) {
      const slice = versionIds.slice(i, i + 200)
      const url = `${BASE}/versions?ids=${encodeURIComponent(JSON.stringify(slice))}`
      const raw = await getJson<RawVersion[]>(url)
      for (const version of raw) {
        const normalized = normalizeVersion(version)
        if (normalized) out.push(normalized)
      }
    }
    return out
  }

  async getProjectsBulk(projectIds: string[]): Promise<ContentProject[]> {
    const out: ContentProject[] = []
    for (let i = 0; i < projectIds.length; i += 200) {
      const slice = projectIds.slice(i, i + 200)
      const url = `${BASE}/projects?ids=${encodeURIComponent(JSON.stringify(slice))}`
      const raw = await getJson<RawProject[]>(url)
      out.push(...raw.map(normalizeProject))
    }
    return out
  }

  /**
   * Identify local jars by hash, then ask which of them have a newer build for
   * this instance. This is how an imported or hand-assembled mods folder gets
   * update tracking without any prior bookkeeping.
   */
  async latestForHashes(
    sha512s: string[],
    loaders: string[],
    gameVersions: string[]
  ): Promise<Record<string, ContentVersion>> {
    const out: Record<string, ContentVersion> = {}
    for (let i = 0; i < sha512s.length; i += 100) {
      const slice = sha512s.slice(i, i + 100)
      const raw = await postJson<Record<string, RawVersion>>(`${BASE}/version_files/update`, {
        hashes: slice,
        algorithm: 'sha512',
        loaders,
        game_versions: gameVersions
      })
      for (const [hash, version] of Object.entries(raw)) {
        const normalized = normalizeVersion(version)
        if (normalized) out[hash] = normalized
      }
    }
    return out
  }

  /** Reverse-lookup the project a local file belongs to, by file hash. */
  async versionByHash(sha512: string): Promise<ContentVersion | null> {
    try {
      const raw = await getJson<RawVersion>(
        `${BASE}/version_file/${encodeURIComponent(sha512)}?algorithm=sha512`
      )
      return normalizeVersion(raw)
    } catch {
      return null
    }
  }
}
