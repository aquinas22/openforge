import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowUpCircle,
  Blocks,
  Boxes,
  Check,
  Download,
  FolderOpen,
  Image,
  Loader2,
  PackageCheck,
  Plus,
  Power,
  Search,
  Settings2,
  Sparkles,
  Trash2,
  TriangleAlert,
  Upload,
  X
} from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { api } from '../api'
import { useStore, type EditorTab } from '../store/store'
import { bytes, cleanError, compact, loaderLabel } from '../util'
import type { ContentKind, ContentProject, Instance, InstalledMod, Provider } from '@shared/types'
import { effectiveProvider } from '@shared/settings'
import { projectFit } from '@shared/compat'
import { SourcePicker } from '../components/SourcePicker'
import { InstanceIcon } from '../components/InstanceIcon'
import { InstanceSettings } from './InstanceSettings'

const TABS: { key: EditorTab; label: string; single: string; icon: JSX.Element }[] = [
  { key: 'mod', label: 'Mods', single: 'mods', icon: <Blocks size={15} /> },
  { key: 'resourcepack', label: 'Resource packs', single: 'resource packs', icon: <Image size={15} /> },
  { key: 'shader', label: 'Shaders', single: 'shaders', icon: <Sparkles size={15} /> },
  { key: 'datapack', label: 'Data packs', single: 'data packs', icon: <Boxes size={15} /> },
  { key: 'settings', label: 'Settings', single: 'settings', icon: <Settings2 size={15} /> }
]

const FILE_HINT: Record<ContentKind, string> = {
  mod: '.jar',
  resourcepack: '.zip',
  shader: '.zip',
  datapack: '.zip',
  modpack: '.zip'
}

const FOLDER_OF: Record<ContentKind, 'mods' | 'resourcepacks' | 'shaderpacks' | undefined> = {
  mod: 'mods',
  resourcepack: 'resourcepacks',
  shader: 'shaderpacks',
  datapack: undefined,
  modpack: undefined
}

/**
 * Editing an instance, in one place: what is installed in each content folder
 * (toggle, update, remove, add from CurseForge or Modrinth, or drop files in),
 * and the profile's own settings.
 */
export function InstanceEditor(): JSX.Element | null {
  const id = useStore((s) => s.editorFor)
  const inst = useStore((s) => s.instances.find((i) => i.id === id))
  const tab = useStore((s) => s.editorTab)
  const openEditor = useStore((s) => s.openEditor)
  const st = useStore(
    useShallow((s) => ({ busy: id ? !!s.busy[id] : false, running: id ? !!s.running[id] : false }))
  )

  if (!id || !inst) return null
  const close = (): void => openEditor(null)
  const locked = st.running || st.busy

  return (
    <div className="scrim editor-scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="editor" role="dialog" aria-modal="true" aria-label={`Edit ${inst.name}`}>
        <header className="editor-head">
          <InstanceIcon inst={inst} size={46} />
          <div className="editor-title">
            <div className="eyebrow">Edit instance</div>
            <h2>{inst.name}</h2>
            <small>
              {loaderLabel(inst.loader)}
              {inst.loaderVersion ? ` ${inst.loaderVersion}` : ''} · Minecraft {inst.mcVersion}
            </small>
          </div>
          {st.running && <span className="chip warn">Running - most changes apply next launch</span>}
          <button className="win-btn" onClick={close} aria-label="Close editor">
            <X size={18} />
          </button>
        </header>

        <nav className="editor-tabs" role="tablist" aria-label="Edit sections">
          {TABS.map((entry) => (
            <button
              key={entry.key}
              role="tab"
              aria-selected={tab === entry.key}
              className={tab === entry.key ? 'active' : ''}
              onClick={() => openEditor(inst.id, entry.key)}
            >
              {entry.icon}
              {entry.label}
            </button>
          ))}
        </nav>

        <div className="editor-body">
          {tab === 'settings' ? (
            <InstanceSettings key={inst.id} inst={inst} locked={locked} running={st.running} />
          ) : (
            <ContentTab key={`${inst.id}:${tab}`} inst={inst} kind={tab} running={st.running} />
          )}
        </div>
      </div>
    </div>
  )
}

// -- Content tabs -------------------------------------------------------------------

function ContentTab({ inst, kind, running }: { inst: Instance; kind: ContentKind; running: boolean }): JSX.Element {
  const toast = useStore((s) => s.toast)
  const openEditor = useStore((s) => s.openEditor)
  const meta = TABS.find((t) => t.key === kind)!
  const [items, setItems] = useState<InstalledMod[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('')
  const [checking, setChecking] = useState(false)
  const [updating, setUpdating] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [adding, setAdding] = useState(false)
  const dragDepth = useRef(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    api
      .listContent(inst.id, kind)
      .then((list) => {
        if (cancelled) return
        setItems(list)
        // An empty folder has nothing to manage yet: go straight to adding.
        if (list.length === 0) setAdding(true)
      })
      .catch(() => !cancelled && setItems([]))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [inst.id, kind])

  const act = async (label: string, work: () => Promise<InstalledMod[]>, done?: string): Promise<void> => {
    setUpdating(label)
    try {
      setItems(await work())
      if (done) toast(done, 'success')
    } catch (e) {
      toast(cleanError(e), 'error')
    } finally {
      setUpdating(null)
    }
  }

  const addPaths = async (paths: string[]): Promise<void> => {
    if (!paths.length) return
    try {
      const result = await api.addContentFiles(inst.id, kind, paths)
      setItems(result.mods)
      if (result.added.length) {
        toast(
          result.added.length === 1 ? `Added ${result.added[0]}` : `Added ${result.added.length} files`,
          'success'
        )
      }
      if (result.skipped.length) toast(`Skipped ${result.skipped.join('; ')}`, 'error')
    } catch (e) {
      toast(cleanError(e), 'error')
    }
  }

  const updatable = items.filter((item) => item.updateAvailable)
  const needle = filter.trim().toLowerCase()
  const visible = needle
    ? items.filter((item) => `${item.displayName} ${item.fileName}`.toLowerCase().includes(needle))
    : items
  const folder = FOLDER_OF[kind]

  return (
    <div
      className={`content-tab${dragging ? ' dragging' : ''}`}
      onDragEnter={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        dragDepth.current++
        setDragging(true)
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (dragDepth.current === 0) setDragging(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        dragDepth.current = 0
        setDragging(false)
        const paths = Array.from(e.dataTransfer.files)
          .map((file) => {
            try {
              return api.pathForFile(file)
            } catch {
              return ''
            }
          })
          .filter(Boolean)
        void addPaths(paths)
      }}
    >
      <div className="content-toolbar">
        <button className={`btn ${adding ? '' : 'primary'}`} onClick={() => setAdding((open) => !open)} aria-expanded={adding}>
          {adding ? <X size={15} /> : <Plus size={15} />} {adding ? 'Close search' : 'Add'}
        </button>
        <button
          className="btn"
          title={`Pick ${FILE_HINT[kind]} files from this computer`}
          onClick={() => act('import', () => api.importContent(inst.id, kind))}
        >
          <Upload size={15} /> Add file
        </button>
        <div className="spacer" style={{ flex: 1 }} />
        <button
          className="btn sm"
          disabled={checking || items.length === 0}
          onClick={async () => {
            setChecking(true)
            try {
              const checked = await api.checkContentUpdates(inst.id, kind)
              setItems(checked)
              const count = checked.filter((item) => item.updateAvailable).length
              toast(count ? `${count} update${count === 1 ? '' : 's'} available` : 'Everything is up to date', 'success')
            } catch (e) {
              toast(cleanError(e), 'error')
            } finally {
              setChecking(false)
            }
          }}
        >
          {checking ? <Loader2 size={14} className="spin" /> : <PackageCheck size={14} />} Check for updates
        </button>
        {updatable.length > 0 && (
          <button
            className="btn sm primary"
            disabled={updating !== null}
            onClick={() =>
              act(
                'all',
                async () => {
                  const result = await api.updateContent(inst.id, kind)
                  if (result.failed?.length) toast(result.failed.join('; '), 'error')
                  return result.mods
                },
                `Updated ${updatable.length} ${meta.single}`
              )
            }
          >
            {updating === 'all' ? <Loader2 size={14} className="spin" /> : <ArrowUpCircle size={14} />} Update all (
            {updatable.length})
          </button>
        )}
        {folder && (
          <button className="btn sm icon" title="Open folder" onClick={() => api.openInstanceFolder(inst.id, folder)}>
            <FolderOpen size={14} />
          </button>
        )}
      </div>

      {adding && (
        <AddPanel
          inst={inst}
          kind={kind}
          installed={items}
          onInstalled={setItems}
          onOpenSettings={() => openEditor(inst.id, 'settings')}
        />
      )}

      <div className="between content-list-head">
        <div className="eyebrow" style={{ margin: 0 }}>
          Installed {meta.single} · {items.length}
        </div>
        {items.length <= 6 && <span className="muted drop-hint">Drop {FILE_HINT[kind]} files here to add them</span>}
        {items.length > 6 && (
          <input
            className="input content-filter"
            aria-label={`Filter installed ${meta.single}`}
            placeholder="Filter installed…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        )}
      </div>

      <div className="panel mod-list">
        {loading ? (
          <div className="empty" style={{ padding: 24 }}>
            <Loader2 size={18} className="spin" /> Reading files…
          </div>
        ) : visible.length === 0 ? (
          <div className="content-empty">
            <Download size={22} />
            <strong>{items.length ? 'Nothing matches that filter' : `No ${meta.single} yet`}</strong>
            <span>
              {items.length
                ? 'Clear the filter to see everything.'
                : `Search above, or drop ${FILE_HINT[kind]} files anywhere on this tab.`}
              {kind === 'shader' && !items.length ? ' Shaders also need Iris or OptiFine in Mods.' : ''}
            </span>
          </div>
        ) : (
          visible.map((item) => (
            <div className={`mod-row${item.enabled ? '' : ' disabled'}`} key={item.fileName}>
              <button
                className={`mod-power${item.enabled ? ' on' : ''}`}
                title={item.enabled ? 'Disable' : 'Enable'}
                aria-label={`${item.enabled ? 'Disable' : 'Enable'} ${item.displayName}`}
                aria-pressed={item.enabled}
                disabled={running || updating !== null}
                onClick={() =>
                  act(item.fileName, () => api.toggleContent(inst.id, kind, item.fileName, !item.enabled))
                }
              >
                <Power size={15} />
              </button>
              <div className="mod-info">
                <strong>{item.displayName}</strong>
                <small>
                  {item.version ? `${item.version} · ` : ''}
                  {item.provider ? `${item.provider === 'modrinth' ? 'Modrinth' : 'CurseForge'} · ` : 'Local file · '}
                  {bytes(item.size)}
                  {item.enabled ? '' : ' · disabled'}
                </small>
              </div>
              {item.updateAvailable && item.provider && item.projectId && (
                <button
                  className="btn sm primary"
                  title={`Update to ${item.updateAvailable.versionNumber}`}
                  disabled={running || updating !== null}
                  onClick={() =>
                    act(
                      item.fileName,
                      async () =>
                        (
                          await api.installContent(inst.id, {
                            provider: item.provider!,
                            projectId: item.projectId!,
                            kind,
                            versionId: item.updateAvailable!.versionId,
                            replaceFileName: item.fileName
                          })
                        ).mods,
                      `${item.displayName} updated to ${item.updateAvailable!.versionNumber}`
                    )
                  }
                >
                  {updating === item.fileName ? <Loader2 size={13} className="spin" /> : <ArrowUpCircle size={13} />}
                  {item.updateAvailable.versionNumber}
                </button>
              )}
              <button
                className="win-btn"
                title="Remove"
                aria-label={`Remove ${item.displayName}`}
                disabled={running || updating !== null}
                onClick={() => {
                  if (confirm(`Remove ${item.displayName} from ${inst.name}?`)) {
                    void act(item.fileName, () => api.deleteContent(inst.id, kind, item.fileName))
                  }
                }}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))
        )}
      </div>

      {dragging && (
        <div className="drop-overlay" aria-hidden="true">
          <Upload size={28} />
          <strong>Drop to add to {meta.label}</strong>
          <span>{FILE_HINT[kind]} files are copied into this instance</span>
        </div>
      )}
    </div>
  )
}

// -- Inline search: add from CurseForge or Modrinth ------------------------------------

const PAGE = 20

function AddPanel({
  inst,
  kind,
  installed,
  onInstalled,
  onOpenSettings
}: {
  inst: Instance
  kind: ContentKind
  installed: InstalledMod[]
  onInstalled: (mods: InstalledMod[]) => void
  onOpenSettings: () => void
}): JSX.Element {
  const providers = useStore((s) => s.providers)
  const savedProvider = useStore((s) => s.settings?.defaultProvider)
  const saveSettings = useStore((s) => s.saveSettings)
  const toast = useStore((s) => s.toast)
  const [provider, setProvider] = useState<Provider>(() =>
    effectiveProvider(savedProvider, providers.curseforge.available)
  )
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ContentProject[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [working, setWorking] = useState<Set<string>>(new Set())
  const [report, setReport] = useState<{ name: string; deps: string[]; failed: string[] } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const seq = useRef(0)

  const modsNeedLoader = kind === 'mod' && inst.loader === 'vanilla'
  // Quilt runs Fabric mods, so do not narrow Quilt searches to Quilt-only builds.
  const loaderFilter = kind === 'mod' && inst.loader !== 'vanilla' && inst.loader !== 'quilt' ? inst.loader : ''

  const search = useCallback(
    async (q: string, p: number, prov: Provider): Promise<void> => {
      const mine = ++seq.current
      setLoading(true)
      setError(null)
      try {
        const res = await api.searchContent({
          query: q,
          page: p,
          pageSize: PAGE,
          sort: 'popular',
          provider: prov,
          kind,
          gameVersion: inst.mcVersion,
          loader: loaderFilter
        })
        if (mine !== seq.current) return
        setResults((prev) => (p === 0 ? res.hits : [...prev, ...res.hits]))
        setTotal(res.total)
      } catch (e) {
        if (mine !== seq.current) return
        setError(cleanError(e))
        if (p === 0) setResults([])
      } finally {
        if (mine === seq.current) setLoading(false)
      }
    },
    [kind, inst.mcVersion, loaderFilter]
  )

  // Search as you type, once typing settles.
  useEffect(() => {
    if (modsNeedLoader) return
    const timer = window.setTimeout(() => {
      setPage(0)
      void search(query, 0, provider)
    }, query ? 350 : 0)
    return () => window.clearTimeout(timer)
  }, [query, provider, search, modsNeedLoader])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const installedBy = useMemo(() => {
    const map = new Map<string, InstalledMod>()
    for (const item of installed) if (item.provider && item.projectId) map.set(`${item.provider}:${item.projectId}`, item)
    return map
  }, [installed])

  async function add(project: ContentProject): Promise<void> {
    setWorking((w) => new Set(w).add(project.id))
    setReport(null)
    try {
      const result = await api.installContent(inst.id, { provider: project.provider, projectId: project.id, kind })
      onInstalled(result.mods)
      setReport({ name: project.name, deps: result.dependencies, failed: result.failed ?? [] })
    } catch (e) {
      toast(cleanError(e), 'error')
    } finally {
      setWorking((w) => {
        const next = new Set(w)
        next.delete(project.id)
        return next
      })
    }
  }

  const label = TABS.find((t) => t.key === kind)?.single ?? 'content'

  return (
    <div className="add-panel panel">
      <div className="add-panel-bar">
        <SourcePicker
          value={provider}
          status={providers}
          onChange={(next) => {
            setProvider(next)
            saveSettings({ defaultProvider: next }).catch(() => undefined)
          }}
        />
        <div className="add-panel-search">
          <Search size={16} />
          <input
            ref={inputRef}
            className="input"
            placeholder={`Search ${label}…`}
            value={query}
            disabled={modsNeedLoader}
            onChange={(e) => setQuery(e.target.value)}
            aria-label={`Search ${label}`}
          />
        </div>
      </div>
      <div className="add-panel-filter">
        Showing {label} for Minecraft {inst.mcVersion}
        {kind === 'mod' && inst.loader !== 'vanilla' ? ` · ${loaderLabel(inst.loader)}` : ''}
        {kind === 'mod' && inst.loader === 'quilt' ? ' (Fabric mods included)' : ''}
        {kind !== 'mod' ? ' · any loader' : ''}
      </div>

      {modsNeedLoader ? (
        <div className="notice warn" style={{ margin: 0 }}>
          <TriangleAlert size={16} />
          <div>
            <strong>Vanilla can&apos;t load mods</strong>
            <span>Switch this instance to Fabric, Forge, NeoForge or Quilt first. Settings checks your files before changing anything.</span>
          </div>
          <button className="btn sm" onClick={onOpenSettings}>
            Open settings
          </button>
        </div>
      ) : (
        <>
          {report && (
            <div className={`notice ${report.failed.length ? 'warn' : 'accent'}`} style={{ marginBottom: 8 }}>
              {report.failed.length ? <TriangleAlert size={16} /> : <Check size={16} />}
              <div>
                <strong>Added {report.name}</strong>
                <span>
                  {report.deps.length
                    ? `Also added what it needs: ${report.deps.join(', ')}.`
                    : 'No extra dependencies were needed.'}
                  {report.failed.length ? ` Could not add: ${report.failed.join('; ')}.` : ''}
                </span>
              </div>
              <button className="win-btn" aria-label="Dismiss" onClick={() => setReport(null)}>
                <X size={14} />
              </button>
            </div>
          )}
          {error && (
            <div className="notice danger" style={{ marginBottom: 8 }}>
              <TriangleAlert size={16} />
              <div>
                <strong>Search failed</strong>
                <span>{error}</span>
              </div>
            </div>
          )}
          <div className="mod-results">
            {results.map((project) => {
              const key = `${project.provider}:${project.id}`
              const have = installedBy.get(key)
              const fit = projectFit(project, inst, kind)
              const busy = working.has(project.id)
              return (
                <div className="mod-result" key={key}>
                  {project.iconUrl ? (
                    <img src={project.iconUrl} alt="" loading="lazy" />
                  ) : (
                    <span className="slot">
                      <Blocks size={16} />
                    </span>
                  )}
                  <div className="mod-info">
                    <strong>{project.name}</strong>
                    <small>{project.summary}</small>
                  </div>
                  <span
                    className={`chip tiny fit-${fit.fit}${fit.fit === 'compatible' ? ' accent' : fit.fit === 'incompatible' ? ' warn' : ''}`}
                    title={fit.reason}
                  >
                    {fit.fit === 'compatible' ? <Check size={10} /> : fit.fit === 'incompatible' ? <TriangleAlert size={10} /> : null}
                    {fit.reason}
                  </span>
                  <span className="muted add-downloads" title="Downloads">
                    <Download size={11} /> {compact(project.downloads)}
                  </span>
                  {have ? (
                    <span className="chip accent installed-chip">
                      <Check size={12} /> Installed
                    </span>
                  ) : (
                    <button className="btn sm primary" disabled={busy} onClick={() => add(project)}>
                      {busy ? <Loader2 size={13} className="spin" /> : <Plus size={13} />} Add
                    </button>
                  )}
                </div>
              )
            })}
            {loading && (
              <div className="row muted" style={{ padding: 14, gap: 8 }}>
                <Loader2 size={15} className="spin" /> Searching {provider === 'modrinth' ? 'Modrinth' : 'CurseForge'}…
              </div>
            )}
            {!loading && !error && results.length === 0 && (
              <div className="muted" style={{ padding: 14 }}>
                Nothing found for {inst.mcVersion}. Try another word, or the other source.
              </div>
            )}
            {!loading && results.length > 0 && results.length < total && (
              <div style={{ padding: 10, textAlign: 'center' }}>
                <button
                  className="btn sm"
                  onClick={() => {
                    const next = page + 1
                    setPage(next)
                    void search(query, next, provider)
                  }}
                >
                  Show more
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
