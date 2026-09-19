import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Blocks,
  Boxes,
  Download,
  ExternalLink,
  Image,
  Loader2,
  Package,
  Search,
  Sparkles,
  TriangleAlert,
  X
} from 'lucide-react'
import { api } from '../api'
import { useStore } from '../store/store'
import type { ContentKind, ContentProject, ContentSort, ContentVersion, Provider } from '@shared/types'
import { bytes, cleanError, compact, timeAgo } from '../util'

const KINDS: { key: ContentKind; label: string; blurb: string; icon: JSX.Element }[] = [
  { key: 'modpack', label: 'Modpacks', blurb: 'Complete curated worlds', icon: <Package size={15} /> },
  { key: 'mod', label: 'Mods', blurb: 'Add one thing at a time', icon: <Blocks size={15} /> },
  { key: 'resourcepack', label: 'Texture packs', blurb: 'Change how it all looks', icon: <Image size={15} /> },
  { key: 'shader', label: 'Shaders', blurb: 'Light, water, and weather', icon: <Sparkles size={15} /> },
  { key: 'datapack', label: 'Data packs', blurb: 'Rules, recipes, loot', icon: <Boxes size={15} /> }
]

const SORTS: { key: ContentSort; label: string }[] = [
  { key: 'popular', label: 'Relevance' },
  { key: 'downloads', label: 'Most downloaded' },
  { key: 'follows', label: 'Most followed' },
  { key: 'updated', label: 'Recently updated' },
  { key: 'released', label: 'Newest' }
]

/** Suggestions per content kind, so the empty state is never a dead end. */
const STARTERS: Record<ContentKind, { label: string; query: string }[]> = {
  modpack: [
    { label: 'Homestead', query: 'homestead' },
    { label: 'All the Mods', query: 'all the mods' },
    { label: 'Adventure', query: 'adventure' },
    { label: 'Tech', query: 'tech' },
    { label: 'Magic', query: 'magic' },
    { label: 'Skyblock', query: 'skyblock' }
  ],
  mod: [
    { label: 'Performance', query: 'sodium' },
    { label: 'Quality of life', query: 'quality of life' },
    { label: 'Storage', query: 'storage' },
    { label: 'World gen', query: 'worldgen' }
  ],
  resourcepack: [
    { label: 'Realistic', query: 'realistic' },
    { label: '32x', query: '32x' },
    { label: 'Faithful', query: 'faithful' },
    { label: 'Cartoon', query: 'cartoon' }
  ],
  shader: [
    { label: 'Complementary', query: 'complementary' },
    { label: 'BSL', query: 'bsl' },
    { label: 'Performance', query: 'lite' }
  ],
  datapack: [
    { label: 'Vanilla tweaks', query: 'tweaks' },
    { label: 'Recipes', query: 'recipes' }
  ]
}

function ProjectCard({
  project,
  onOpen
}: {
  project: ContentProject
  onOpen: (p: ContentProject) => void
}): JSX.Element {
  return (
    <button className="panel discover-card" onClick={() => onOpen(project)}>
      <div className="slot discover-card-art">
        {project.iconUrl ? (
          <img src={project.iconUrl} alt="" loading="lazy" />
        ) : (
          <Package size={32} style={{ opacity: 0.4 }} />
        )}
        <span className="chip discover-card-downloads">
          <Download size={12} /> {compact(project.downloads)}
        </span>
        <span className={`provider-tag ${project.provider}`}>
          {project.provider === 'modrinth' ? 'Modrinth' : 'CurseForge'}
        </span>
      </div>
      <div className="discover-card-body">
        <div className="discover-card-title">{project.name}</div>
        <div className="muted discover-card-author">
          {project.authors[0] ? `by ${project.authors[0]}` : 'Community project'}
        </div>
        <div className="dim discover-card-summary">{project.summary}</div>
        <div className="discover-card-tags">
          {project.loaders.slice(0, 2).map((loader) => (
            <span key={loader} className="chip tiny">
              {loader}
            </span>
          ))}
          {project.gameVersions.slice(0, 1).map((version) => (
            <span key={version} className="chip tiny">
              {version}
            </span>
          ))}
        </div>
      </div>
    </button>
  )
}

function ProjectDrawer({
  project,
  kind,
  onClose
}: {
  project: ContentProject
  kind: ContentKind
  onClose: () => void
}): JSX.Element {
  const [versions, setVersions] = useState<ContentVersion[] | null>(null)
  const [detail, setDetail] = useState<ContentProject>(project)
  const [loading, setLoading] = useState(true)
  const [working, setWorking] = useState<string | null>(null)
  const instances = useStore((s) => s.instances)
  const installPack = useStore((s) => s.installPack)
  const toast = useStore((s) => s.toast)

  // Installing a mod or texture pack needs somewhere to put it.
  const [target, setTarget] = useState<string>(instances[0]?.id ?? '')
  const isPack = kind === 'modpack'

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    Promise.all([
      api.getVersions(project.provider, project.id).catch(() => [] as ContentVersion[]),
      api.getProject(project.provider, project.id).catch(() => project)
    ])
      .then(([v, p]) => {
        if (cancelled) return
        setVersions(v.filter((entry) => !entry.isServerPack))
        setDetail(p)
      })
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [project])

  const targetInstance = instances.find((i) => i.id === target)

  /** Versions that fit the chosen instance float to the top for non-packs. */
  const ordered = useMemo(() => {
    if (!versions) return null
    if (isPack || !targetInstance) return versions
    const fits = (v: ContentVersion): boolean =>
      (!v.gameVersions.length || v.gameVersions.includes(targetInstance.mcVersion)) &&
      (kind !== 'mod' ||
        !v.loaders.length ||
        v.loaders.some((l) => new RegExp(targetInstance.loader, 'i').test(l)))
    return [...versions].sort((a, b) => Number(fits(b)) - Number(fits(a)))
  }, [versions, isPack, targetInstance, kind])

  async function install(version: ContentVersion): Promise<void> {
    if (isPack) {
      installPack({
        provider: project.provider,
        projectId: project.id,
        versionId: version.id,
        name: project.name,
        iconUrl: project.iconUrl ?? undefined
      })
      onClose()
      return
    }
    if (!target) {
      toast('Create an instance first, then install content into it.', 'error')
      return
    }
    setWorking(version.id)
    try {
      const result = await api.installContent(target, {
        provider: project.provider,
        projectId: project.id,
        kind,
        versionId: version.id
      })
      const extra = result.dependencies.length ? ` (+${result.dependencies.length} dependencies)` : ''
      toast(`${project.name} added to ${targetInstance?.name ?? 'instance'}${extra}`, 'success')
      if (result.failed?.length) toast(result.failed.join('; '), 'error')
    } catch (e) {
      toast(cleanError(e), 'error')
    } finally {
      setWorking(null)
    }
  }

  return (
    <>
      <div className="scrim" onClick={onClose} style={{ background: 'rgba(4,5,10,0.5)' }} />
      <aside className="drawer">
        <div className="drawer-hero">
          {(detail.gallery?.[0] || detail.iconUrl) && (
            <img src={detail.gallery?.[0] || detail.iconUrl || ''} alt="" />
          )}
          <div className="drawer-hero-wash" />
          <button className="win-btn drawer-close" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div className="drawer-head">
          <h2>{detail.name}</h2>
          <div className="row drawer-chips">
            <span className={`provider-tag ${detail.provider}`}>
              {detail.provider === 'modrinth' ? 'Modrinth' : 'CurseForge'}
            </span>
            <span className="chip">
              <Download size={12} /> {compact(detail.downloads)}
            </span>
            {detail.categories.slice(0, 3).map((c) => (
              <span key={c} className="chip">
                {c}
              </span>
            ))}
            {detail.pageUrl && (
              <button className="chip" onClick={() => api.openExternal(detail.pageUrl!)}>
                Open page <ExternalLink size={12} />
              </button>
            )}
          </div>
          <p className="dim drawer-summary">{detail.summary}</p>
        </div>

        {!isPack && (
          <div className="drawer-target">
            <label htmlFor="install-target">Install into</label>
            {instances.length ? (
              <select
                id="install-target"
                className="select"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
              >
                {instances.map((inst) => (
                  <option key={inst.id} value={inst.id}>
                    {inst.name} — {inst.mcVersion} {inst.loader}
                  </option>
                ))}
              </select>
            ) : (
              <span className="muted">Create an instance first.</span>
            )}
          </div>
        )}

        <div className="drawer-body">
          <div className="eyebrow" style={{ marginBottom: 12 }}>
            Versions
          </div>
          {loading ? (
            <div className="row muted" style={{ padding: 20 }}>
              <Loader2 className="spin" size={16} /> Loading versions…
            </div>
          ) : ordered && ordered.length ? (
            ordered.slice(0, 40).map((version) => (
              <div key={version.id} className="version-row panel">
                <div className="version-main">
                  <div className="version-name">{version.name}</div>
                  <div className="row muted version-meta">
                    <span className={`chip tiny ${version.releaseType === 'release' ? 'accent' : ''}`}>
                      {version.releaseType}
                    </span>
                    {version.gameVersions.slice(0, 2).map((v) => (
                      <span key={v}>{v}</span>
                    ))}
                    {version.loaders[0] && <span>· {version.loaders[0]}</span>}
                    {version.fileSize > 0 && <span>· {bytes(version.fileSize)}</span>}
                    <span>· {timeAgo(version.datePublished)}</span>
                  </div>
                </div>
                <button
                  className="btn sm primary"
                  disabled={working !== null || (!isPack && !target)}
                  onClick={() => install(version)}
                >
                  {working === version.id ? (
                    <Loader2 size={14} className="spin" />
                  ) : (
                    <Download size={14} />
                  )}
                  {isPack ? 'Install' : 'Add'}
                </button>
              </div>
            ))
          ) : (
            <div className="muted" style={{ padding: 20 }}>
              No downloadable versions found.
            </div>
          )}
          <div style={{ height: 24 }} />
        </div>
      </aside>
    </>
  )
}

export function Discover(): JSX.Element {
  const providers = useStore((s) => s.providers)
  const defaultProvider = useStore((s) => s.settings?.defaultProvider)
  const versionsList = useStore((s) => s.versions)
  const importPack = useStore((s) => s.importPack)

  const [provider, setProvider] = useState<Provider>(defaultProvider ?? 'modrinth')
  const [kind, setKind] = useState<ContentKind>('modpack')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<ContentSort>('popular')
  const [gameVersion, setGameVersion] = useState('')
  const [results, setResults] = useState<ContentProject[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<ContentProject | null>(null)

  const releaseVersions = useMemo(
    () => versionsList.filter((v) => v.type === 'release').slice(0, 40).map((v) => v.id),
    [versionsList]
  )

  const run = useCallback(
    async (opts: { query: string; sort: ContentSort; page: number; provider: Provider; kind: ContentKind; gameVersion: string }) => {
      setLoading(true)
      setError(null)
      try {
        const res = await api.searchContent({
          query: opts.query,
          sort: opts.sort,
          page: opts.page,
          provider: opts.provider,
          kind: opts.kind,
          gameVersion: opts.gameVersion || undefined
        })
        setResults(res.hits)
        setTotal(res.total)
      } catch (e) {
        setError(cleanError(e))
        setResults([])
        setTotal(0)
      } finally {
        setLoading(false)
      }
    },
    []
  )

  useEffect(() => {
    run({ query, sort, page, provider, kind, gameVersion })
    // Re-running on `query` would search on every keystroke; the user submits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sort, page, provider, kind, gameVersion])

  const cfUnavailable = provider === 'curseforge' && !providers.curseforge.available

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="eyebrow">Content library</div>
          <h1 className="page-title">
            Discover <span className="gradient-text">everything</span>
          </h1>
          <p className="page-subtitle">
            Modpacks, mods, texture packs, and shaders from Modrinth and CurseForge in one place.
          </p>
        </div>
        <button className="btn" onClick={() => importPack()}>
          <Package size={15} /> Import a pack file
        </button>
      </div>

      <div className="kind-tabs" role="tablist" aria-label="Content type">
        {KINDS.map((entry) => (
          <button
            key={entry.key}
            role="tab"
            aria-selected={kind === entry.key}
            className={`kind-tab${kind === entry.key ? ' active' : ''}`}
            onClick={() => {
              setKind(entry.key)
              setPage(0)
            }}
          >
            {entry.icon}
            <span>
              <strong>{entry.label}</strong>
              <small>{entry.blurb}</small>
            </span>
          </button>
        ))}
      </div>

      <div className="provider-switch" role="tablist" aria-label="Provider">
        <button
          role="tab"
          aria-selected={provider === 'modrinth'}
          className={provider === 'modrinth' ? 'active' : ''}
          onClick={() => {
            setProvider('modrinth')
            setPage(0)
          }}
        >
          Modrinth
          <small>No setup needed</small>
        </button>
        <button
          role="tab"
          aria-selected={provider === 'curseforge'}
          className={provider === 'curseforge' ? 'active' : ''}
          onClick={() => {
            setProvider('curseforge')
            setPage(0)
          }}
        >
          CurseForge
          <small>
            {providers.curseforge.available
              ? providers.curseforge.bulk
                ? 'Direct key · fast installs'
                : `Connected via ${providers.curseforge.mode}`
              : 'Needs a key'}
          </small>
        </button>
      </div>

      <div className="discovery-starters">
        <span>Try</span>
        {(STARTERS[kind] ?? []).map((starter) => (
          <button
            key={starter.query}
            className={query === starter.query ? 'active' : ''}
            onClick={() => {
              setQuery(starter.query)
              setPage(0)
              run({ query: starter.query, sort, page: 0, provider, kind, gameVersion })
            }}
          >
            {starter.label}
          </button>
        ))}
      </div>

      <div className="discover-search">
        <div style={{ position: 'relative', flex: 1 }}>
          <Search size={17} style={{ position: 'absolute', left: 14, top: 13, color: 'var(--muted)' }} />
          <input
            id="discover-search"
            className="input"
            style={{ paddingLeft: 40 }}
            placeholder={
              kind === 'modpack'
                ? 'Search modpacks (Homestead, All the Mods, RLCraft…)'
                : `Search ${KINDS.find((k) => k.key === kind)?.label.toLowerCase()}…`
            }
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                setPage(0)
                run({ query, sort, page: 0, provider, kind, gameVersion })
              }
            }}
          />
        </div>
        <select
          className="select"
          style={{ width: 150 }}
          value={gameVersion}
          onChange={(e) => {
            setGameVersion(e.target.value)
            setPage(0)
          }}
          aria-label="Minecraft version"
        >
          <option value="">Any version</option>
          {releaseVersions.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
        <select
          className="select"
          style={{ width: 190 }}
          value={sort}
          onChange={(e) => {
            setSort(e.target.value as ContentSort)
            setPage(0)
          }}
          aria-label="Sort order"
        >
          {SORTS.map((s) => (
            <option key={s.key} value={s.key}>
              {s.label}
            </option>
          ))}
        </select>
        <button
          className="btn primary"
          onClick={() => {
            setPage(0)
            run({ query, sort, page: 0, provider, kind, gameVersion })
          }}
        >
          Search
        </button>
      </div>

      {cfUnavailable && (
        <div className="notice">
          <TriangleAlert size={16} />
          <div>
            <strong>CurseForge needs a key</strong>
            <span>
              Add a free API key or a proxy URL in Settings. Modrinth works right now with no setup —
              and carries most of the same packs, Homestead included.
            </span>
          </div>
        </div>
      )}

      {error && (
        <div className="notice danger">
          <TriangleAlert size={16} />
          <div>
            <strong>Search failed</strong>
            <span>{error}</span>
          </div>
        </div>
      )}

      {loading ? (
        <div className="grid-cards">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="skeleton" style={{ height: 250 }} />
          ))}
        </div>
      ) : (
        <>
          <div className="results-summary">
            <span>
              {compact(total)} {KINDS.find((k) => k.key === kind)?.label.toLowerCase()}
            </span>
            <span>Sorted by {SORTS.find((option) => option.key === sort)?.label.toLowerCase()}</span>
          </div>
          {results.length ? (
            <>
              <div className="grid-cards">
                {results.map((project) => (
                  <ProjectCard key={`${project.provider}:${project.id}`} project={project} onOpen={setSelected} />
                ))}
              </div>
              <div className="pager">
                <button className="btn sm" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
                  Previous
                </button>
                <span className="muted">Page {page + 1}</span>
                <button
                  className="btn sm"
                  disabled={(page + 1) * 20 >= total}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </button>
              </div>
            </>
          ) : (
            <div className="empty search-empty">
              <Search size={28} />
              <h3>Nothing found</h3>
              <p>Try a broader term, clear the version filter, or switch provider.</p>
            </div>
          )}
        </>
      )}

      {selected && <ProjectDrawer project={selected} kind={kind} onClose={() => setSelected(null)} />}
    </div>
  )
}
