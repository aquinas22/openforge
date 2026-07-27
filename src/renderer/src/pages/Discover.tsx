import { useEffect, useState } from 'react'
import { Download, ExternalLink, Loader2, Search, X, Package, TriangleAlert } from 'lucide-react'
import { api } from '../api'
import { useStore } from '../store/store'
import type { CfFile, CfMod } from '@shared/types'
import type { CfSearchInput } from '@shared/ipc'
import { bytes, cleanError, compact } from '../util'
import { Sprite, sprites } from '../components/bits'

const SORTS: { key: NonNullable<CfSearchInput['sort']>; label: string }[] = [
  { key: 'popular', label: 'Popular' },
  { key: 'downloads', label: 'Most downloaded' },
  { key: 'updated', label: 'Recently updated' },
  { key: 'released', label: 'Newest' }
]

function ModpackCard({ mod, onOpen }: { mod: CfMod; onOpen: (m: CfMod) => void }): JSX.Element {
  return (
    <div
      className="panel"
      style={{ overflow: 'hidden', cursor: 'pointer', display: 'flex', flexDirection: 'column' }}
      onClick={() => onOpen(mod)}
    >
      <div className="slot" style={{ height: 128, position: 'relative' }}>
        {mod.logo ? (
          <img src={mod.logo} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        ) : (
          <Package size={32} style={{ opacity: 0.4 }} />
        )}
        <span className="chip" style={{ position: 'absolute', bottom: 8, right: 8 }}>
          <Download size={12} /> {compact(mod.downloadCount)}
        </span>
      </div>
      <div style={{ padding: '12px 14px 14px', flex: 1, display: 'flex', flexDirection: 'column' }}>
        <div style={{ fontWeight: 600, marginBottom: 3 }}>{mod.name}</div>
        <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
          by {mod.authors[0] ?? 'Unknown'}
        </div>
        <div
          className="dim"
          style={{
            fontSize: 12.5,
            lineHeight: 1.5,
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden'
          }}
        >
          {mod.summary}
        </div>
      </div>
    </div>
  )
}

function PackDrawer({ mod, onClose }: { mod: CfMod; onClose: () => void }): JSX.Element {
  const [files, setFiles] = useState<CfFile[] | null>(null)
  const [loading, setLoading] = useState(true)
  const cfInstall = useStore((s) => s.cfInstall)

  useEffect(() => {
    setLoading(true)
    api
      .cfFiles(mod.id, 0)
      .then((f) => setFiles(f.filter((x) => !x.isServerPack)))
      .catch(() => setFiles([]))
      .finally(() => setLoading(false))
  }, [mod.id])

  return (
    <>
      <div className="scrim" onClick={onClose} style={{ background: 'rgba(4,5,10,0.5)' }} />
      <aside className="drawer">
        <div style={{ position: 'relative', height: 150, flexShrink: 0 }}>
          {mod.logo && (
            <img src={mod.logo} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', opacity: 0.5 }} />
          )}
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(12,13,16,0.55)' }} />
          <button className="win-btn" style={{ position: 'absolute', top: 12, right: 12 }} onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <div style={{ padding: '0 24px 20px', marginTop: -30, position: 'relative', flexShrink: 0 }}>
          <h2 style={{ fontSize: 24, marginBottom: 8 }}>{mod.name}</h2>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
            <span className="chip">
              <Download size={12} /> {compact(mod.downloadCount)}
            </span>
            {mod.categories.slice(0, 3).map((c) => (
              <span key={c} className="chip">
                {c}
              </span>
            ))}
            {mod.links?.websiteUrl && (
              <button className="chip" onClick={() => api.openExternal(mod.links.websiteUrl)}>
                CurseForge <ExternalLink size={12} />
              </button>
            )}
          </div>
          <p className="dim" style={{ fontSize: 13, lineHeight: 1.6 }}>
            {mod.summary}
          </p>
        </div>
        <div style={{ padding: '0 24px', overflowY: 'auto', flex: 1 }}>
          <div className="eyebrow" style={{ marginBottom: 12 }}>
            Versions
          </div>
          {loading ? (
            <div className="row muted" style={{ padding: 20 }}>
              <Loader2 className="spin" size={16} /> Loading files…
            </div>
          ) : files && files.length ? (
            files.map((f) => {
              const isForge = f.loaders.some((l) => /forge/i.test(l))
              return (
                <div
                  key={f.id}
                  className="panel"
                  style={{ padding: '12px 14px', marginBottom: 10, display: 'flex', gap: 12, alignItems: 'center' }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {f.displayName}
                    </div>
                    <div className="row muted" style={{ gap: 8, fontSize: 11.5, flexWrap: 'wrap' }}>
                      <span className={`chip ${f.releaseType === 'release' ? 'accent' : ''}`} style={{ height: 20 }}>
                        {f.releaseType}
                      </span>
                      {f.gameVersions.slice(0, 2).map((v) => (
                        <span key={v}>{v}</span>
                      ))}
                      {f.loaders[0] && <span>· {f.loaders[0]}</span>}
                      <span>· {bytes(f.fileLength)}</span>
                      {isForge && (
                        <span className="chip warn" style={{ height: 20 }} title="Forge auto-install is not yet supported">
                          <TriangleAlert size={11} /> Forge
                        </span>
                      )}
                    </div>
                  </div>
                  <button
                    className="btn sm primary"
                    onClick={() => {
                      cfInstall({ projectId: mod.id, fileId: f.id, name: mod.name, iconUrl: mod.logo ?? undefined })
                      onClose()
                    }}
                  >
                    <Download size={14} /> Install
                  </button>
                </div>
              )
            })
          ) : (
            <div className="muted" style={{ padding: 20 }}>
              No downloadable files found.
            </div>
          )}
          <div style={{ height: 20 }} />
        </div>
      </aside>
    </>
  )
}

export function Discover(): JSX.Element {
  const cfStatus = useStore((s) => s.cfStatus)
  const setRoute = useStore((s) => s.setRoute)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<NonNullable<CfSearchInput['sort']>>('popular')
  const [results, setResults] = useState<CfMod[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<CfMod | null>(null)

  async function run(q: string, s: NonNullable<CfSearchInput['sort']>): Promise<void> {
    setLoading(true)
    setError(null)
    try {
      const res = await api.cfSearch({ query: q, sort: s })
      setResults(res.packs)
    } catch (e) {
      setError(cleanError(e))
      setResults([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (cfStatus.available) run('', sort)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sort, cfStatus.available])

  if (!cfStatus.available) {
    return (
      <div className="page">
        <div className="empty" style={{ paddingTop: 90 }}>
          <Sprite src={sprites.compass} size={72} />
          <h2 style={{ fontSize: 22, marginBottom: 8 }}>Connect CurseForge</h2>
          <p style={{ maxWidth: 440, margin: '0 auto 22px' }}>
            Add your CurseForge API key in Settings to browse and install modpacks.
          </p>
          <button className="btn primary" onClick={() => setRoute('settings')}>
            Open settings
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="eyebrow">CurseForge · {cfStatus.mode}</div>
          <h1 className="page-title">
            Discover <span className="gradient-text">modpacks</span>
          </h1>
        </div>
      </div>

      <div className="row" style={{ gap: 10, marginBottom: 22 }}>
        <div style={{ position: 'relative', flex: 1 }}>
          <Search size={17} style={{ position: 'absolute', left: 14, top: 13, color: 'var(--muted)' }} />
          <input
            className="input"
            style={{ paddingLeft: 40 }}
            placeholder="Search modpacks (e.g. All the Mods, RLCraft, Better MC)…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && run(query, sort)}
          />
        </div>
        <select className="select" style={{ width: 200 }} value={sort} onChange={(e) => setSort(e.target.value as never)}>
          {SORTS.map((s) => (
            <option key={s.key} value={s.key}>
              {s.label}
            </option>
          ))}
        </select>
        <button className="btn primary" onClick={() => run(query, sort)}>
          Search
        </button>
      </div>

      {error && (
        <div className="panel" style={{ padding: 16, marginBottom: 16, boxShadow: 'inset 0 0 0 3px var(--danger)' }}>
          <span className="row" style={{ color: 'var(--danger)' }}>
            <TriangleAlert size={16} /> {error}
          </span>
        </div>
      )}

      {loading ? (
        <div className="grid-cards">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="skeleton" style={{ height: 230 }} />
          ))}
        </div>
      ) : (
        <div className="grid-cards">
          {results.map((m) => (
            <ModpackCard key={m.id} mod={m} onOpen={setSelected} />
          ))}
        </div>
      )}

      {selected && <PackDrawer mod={selected} onClose={() => setSelected(null)} />}
    </div>
  )
}
