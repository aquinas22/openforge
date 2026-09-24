import { useEffect, useMemo, useState } from 'react'
import {
  Boxes,
  Clock,
  Folder,
  Play,
  Plus,
  Loader2,
  CircleStop,
  Sparkles,
  Download,
  Search,
  Star,
  LayoutGrid,
  List,
  Gamepad2,
  Layers3,
  Timer
} from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { api } from '../api'
import { useStore } from '../store/store'
import type { Instance } from '@shared/types'
import { loaderLabel, playtime, timeAgo } from '../util'
import { Sprite, blockFor } from '../components/bits'

function useInstState(id: string): {
  busy: boolean
  running: boolean
  label?: string
  progress?: number
} {
  return useStore(
    useShallow((s) => ({
      busy: !!s.busy[id],
      running: !!s.running[id],
      label: s.progress[id]?.label,
      progress: s.progress[id]?.progress
    }))
  )
}

function PlayControl({ inst, big }: { inst: Instance; big?: boolean }): JSX.Element {
  const st = useInstState(inst.id)
  const launch = useStore((s) => s.launch)
  const kill = useStore((s) => s.kill)
  const cls = big ? 'btn-play' : 'btn primary'

  if (st.running) {
    return (
      <button className={big ? 'btn-play' : 'btn danger'} onClick={() => kill(inst.id)}>
        <CircleStop size={big ? 22 : 16} /> Stop
      </button>
    )
  }
  if (st.busy) {
    return (
      <button className={cls} disabled>
        <Loader2 size={big ? 22 : 16} className="spin" /> {st.label ?? 'Working…'}
      </button>
    )
  }
  return (
    <button className={cls} onClick={() => launch(inst.id)}>
      {inst.installed ? <Play size={big ? 22 : 16} fill="currentColor" /> : <Download size={big ? 22 : 16} />}
      {inst.installed ? 'Play' : 'Install & Play'}
    </button>
  )
}

function Hero({ inst }: { inst: Instance }): JSX.Element {
  const openConsole = useStore((s) => s.openConsole)
  const openDetail = useStore((s) => s.openDetail)
  const running = useStore((s) => !!s.running[inst.id])
  return (
    <div
      className="panel"
      style={{
        position: 'relative',
        overflow: 'hidden',
        padding: 30,
        marginBottom: 30,
        minHeight: 210,
        display: 'flex',
        alignItems: 'flex-end'
      }}
    >
      {inst.iconUrl ? (
        <img
          src={inst.iconUrl}
          alt=""
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            opacity: 0.32,
            filter: 'saturate(1.1)'
          }}
        />
      ) : (
        <div
          className="hero-plate"
          style={{ position: 'absolute', inset: 0 }}
        />
      )}
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(12,13,16,0.74)' }} />
      <div className="on-plate" style={{ position: 'relative', width: '100%' }}>
        <div className="row" style={{ marginBottom: 10 }}>
          <span className="chip accent">
            <Sparkles size={13} /> Continue playing
          </span>
          {running && <span className="chip">Running now</span>}
        </div>
        <h1 style={{ fontSize: 38, marginBottom: 10 }}>{inst.name}</h1>
        <div className="row dim" style={{ gap: 16, marginBottom: 22, fontSize: 13 }}>
          <span className="row" style={{ gap: 6 }}>
            <Boxes size={15} /> {loaderLabel(inst.loader)} {inst.mcVersion}
          </span>
          <span className="row" style={{ gap: 6 }}>
            <Clock size={15} /> {timeAgo(inst.lastPlayed)}
          </span>
          <span className="muted">{playtime(inst.totalPlaySeconds)} played</span>
        </div>
        <div className="row" style={{ gap: 12 }}>
          <PlayControl inst={inst} big />
          <button className="btn" onClick={() => openDetail(inst.id)}>
            Customize profile
          </button>
          <button className="btn ghost" onClick={() => openConsole(inst.id)}>
            View log
          </button>
          {!running && (
            <span className="kbd-hint" aria-hidden="true">
              <kbd>Ctrl</kbd> + <kbd>Enter</kbd> to play
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

type SortKey = 'recent' | 'name' | 'playtime' | 'version'
type ViewMode = 'grid' | 'list'

function InstanceCard({
  inst,
  favorite,
  onFavorite,
  view
}: {
  inst: Instance
  favorite: boolean
  onFavorite: () => void
  view: ViewMode
}): JSX.Element {
  const st = useInstState(inst.id)
  const openDetail = useStore((s) => s.openDetail)
  const pct = st.progress && st.progress >= 0 ? Math.round(st.progress * 100) : null

  return (
    <div
      className={`panel card-instance ${view}`}
      title={`Customize ${inst.name}`}
      style={{ overflow: 'hidden', cursor: 'pointer' }}
      onClick={() => openDetail(inst.id)}
    >
      <div className="slot" style={{ position: 'relative', height: 120 }}>
        {inst.iconUrl ? (
          <img src={inst.iconUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        ) : (
          <Sprite src={blockFor(inst)} size={64} />
        )}
        <div style={{ position: 'absolute', top: 8, left: 8, display: 'flex', gap: 6 }}>
          <span className="chip">{loaderLabel(inst.loader)}</span>
        </div>
        {st.running && (
          <span className="chip accent" style={{ position: 'absolute', top: 8, right: 8 }}>
            Running
          </span>
        )}
        {inst.loaderPending && !st.running && (
          <span className="chip warn" style={{ position: 'absolute', top: 8, right: 8 }}>
            Loader pending
          </span>
        )}
        <button
          className={`favorite-btn${favorite ? ' active' : ''}`}
          title={favorite ? 'Remove from favorites' : 'Add to favorites'}
          aria-label={favorite ? `Remove ${inst.name} from favorites` : `Add ${inst.name} to favorites`}
          aria-pressed={favorite}
          onClick={(event) => {
            event.stopPropagation()
            onFavorite()
          }}
        >
          <Star size={15} fill={favorite ? 'currentColor' : 'none'} />
        </button>
      </div>
      <div className="card-instance-body">
        <div className="card-instance-title">
          {inst.name}
        </div>
        <div className="card-instance-meta muted">
          {inst.mcVersion} ·{' '}
          {!inst.installed
            ? 'not installed'
            : inst.lastPlayed
              ? `played ${timeAgo(inst.lastPlayed)} · ${playtime(inst.totalPlaySeconds)}`
              : 'ready, never played'}
        </div>
        {st.busy ? (
          <div className="dock-bar" style={{ height: 6 }}>
            <span style={{ width: `${pct ?? 0}%`, ...(pct === null ? { animation: 'none' } : {}) }} />
          </div>
        ) : (
          <div onClick={(e) => e.stopPropagation()}>
            <PlayControl inst={inst} />
          </div>
        )}
      </div>
    </div>
  )
}

export function Library({ onNew }: { onNew: () => void }): JSX.Element {
  const instances = useStore((s) => s.instances)
  const setRoute = useStore((s) => s.setRoute)
  const settings = useStore((s) => s.settings)
  const [query, setQuery] = useState('')
  const [loader, setLoader] = useState<'all' | Instance['loader']>('all')
  const [sort, setSort] = useState<SortKey>('recent')
  const [view, setView] = useState<ViewMode>('grid')
  const [favorites, setFavorites] = useState<string[]>(() => {
    try {
      const raw =
        localStorage.getItem('openforge:favorites') ??
        localStorage.getItem('ars-fodina:favorites') ??
        '[]'
      const saved: unknown = JSON.parse(raw)
      return Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string') : []
    } catch {
      return []
    }
  })

  useEffect(() => {
    localStorage.setItem('openforge:favorites', JSON.stringify(favorites))
  }, [favorites])

  const sorted = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    return [...instances]
      .filter(
        (inst) =>
          (loader === 'all' || inst.loader === loader) &&
          (!normalizedQuery ||
            inst.name.toLowerCase().includes(normalizedQuery) ||
            inst.mcVersion.toLowerCase().includes(normalizedQuery) ||
            loaderLabel(inst.loader).toLowerCase().includes(normalizedQuery))
      )
      .sort((a, b) => {
        const favoriteDelta = Number(favorites.includes(b.id)) - Number(favorites.includes(a.id))
        if (favoriteDelta) return favoriteDelta
        if (sort === 'name') return a.name.localeCompare(b.name)
        if (sort === 'playtime') return (b.totalPlaySeconds ?? 0) - (a.totalPlaySeconds ?? 0)
        if (sort === 'version') return b.mcVersion.localeCompare(a.mcVersion, undefined, { numeric: true })
        return (
          new Date(b.lastPlayed ?? b.createdAt).getTime() -
          new Date(a.lastPlayed ?? a.createdAt).getTime()
        )
      })
  }, [favorites, instances, loader, query, sort])

  // After every hook: returning earlier changes the hook count once the
  // first instance appears, which React treats as a crash.
  if (instances.length === 0) {
    return (
      <div className="page">
        <div className="empty empty-showcase">
          <div className="empty-art" aria-hidden="true" />
          <h2 style={{ fontSize: 24, marginBottom: 8 }}>Your library is empty</h2>
          <p style={{ maxWidth: 460, margin: '0 auto 22px' }}>
            Build an instance on any loader, or install a modpack from Modrinth or CurseForge.
            Openforge fetches the Java each pack needs, so there is nothing to set up first.
          </p>
          <div className="row" style={{ justifyContent: 'center', gap: 12 }}>
            <button className="btn primary" onClick={onNew}>
              <Plus size={16} /> New instance
            </button>
            <button className="btn" onClick={() => setRoute('discover')}>
              <Sparkles size={16} /> Browse modpacks
            </button>
          </div>
        </div>
      </div>
    )
  }

  const recent = [...instances].sort(
    (a, b) =>
      new Date(b.lastPlayed ?? b.createdAt).getTime() -
      new Date(a.lastPlayed ?? a.createdAt).getTime()
  )
  const featured = recent[0]
  const totalSeconds = instances.reduce((sum, inst) => sum + (inst.totalPlaySeconds ?? 0), 0)
  const loaders = new Set(instances.map((inst) => inst.loader)).size
  const favoriteCount = instances.filter((inst) => favorites.includes(inst.id)).length

  function toggleFavorite(id: string): void {
    setFavorites((current) =>
      current.includes(id) ? current.filter((favoriteId) => favoriteId !== id) : [...current, id]
    )
  }

  return (
    <div className="page">
      <Hero inst={featured} />
      <div className="collection-stats" aria-label="Library overview">
        <div className="collection-stat">
          <span className="stat-icon"><Gamepad2 size={18} /></span>
          <span><strong>{instances.length}</strong><small>Playable instances</small></span>
        </div>
        <div className="collection-stat">
          <span className="stat-icon"><Timer size={18} /></span>
          <span><strong>{playtime(totalSeconds)}</strong><small>Total time played</small></span>
        </div>
        <div className="collection-stat">
          <span className="stat-icon"><Layers3 size={18} /></span>
          <span><strong>{loaders}</strong><small>Loaders in use</small></span>
        </div>
      </div>

      <div className="page-head library-head">
        <div>
          <div className="eyebrow">Library</div>
          <h2 className="page-title">Your collection</h2>
          <p className="page-subtitle">Jump back into a world or prepare your next adventure.</p>
        </div>
        <div className="row">
          <button className="btn" onClick={() => settings && api.openFolder(settings.gameDir)}>
            <Folder size={15} /> Game folder
          </button>
          <button className="btn primary" onClick={onNew}>
            <Plus size={16} /> New
          </button>
        </div>
      </div>

      <div className="library-toolbar">
        <div className="search-field">
          <Search size={17} />
          <input
            id="library-search"
            className="input"
            placeholder="Search instances, versions, loaders…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <select
          className="select compact-select"
          aria-label="Filter by loader"
          value={loader}
          onChange={(event) => setLoader(event.target.value as typeof loader)}
        >
          <option value="all">All loaders</option>
          <option value="vanilla">Vanilla</option>
          <option value="fabric">Fabric</option>
          <option value="forge">Forge</option>
          <option value="neoforge">NeoForge</option>
          <option value="quilt">Quilt</option>
        </select>
        <select
          className="select compact-select"
          aria-label="Sort instances"
          value={sort}
          onChange={(event) => setSort(event.target.value as SortKey)}
        >
          <option value="recent">Recently played</option>
          <option value="name">Name</option>
          <option value="playtime">Most played</option>
          <option value="version">Minecraft version</option>
        </select>
        <div className="view-toggle" aria-label="Library view">
          <button
            className={view === 'grid' ? 'active' : ''}
            title="Grid view"
            aria-label="Grid view"
            aria-pressed={view === 'grid'}
            onClick={() => setView('grid')}
          >
            <LayoutGrid size={16} />
          </button>
          <button
            className={view === 'list' ? 'active' : ''}
            title="List view"
            aria-label="List view"
            aria-pressed={view === 'list'}
            onClick={() => setView('list')}
          >
            <List size={17} />
          </button>
        </div>
      </div>

      <div className="results-summary">
        <span>
          {sorted.length} of {instances.length} shown
        </span>
        {favoriteCount > 0 && <span><Star size={12} fill="currentColor" /> Favorites stay on top</span>}
      </div>

      {sorted.length ? (
        <div className={`grid-cards ${view === 'list' ? 'list-view' : ''}`}>
        {sorted.map((inst) => (
            <InstanceCard
              key={inst.id}
              inst={inst}
              favorite={favorites.includes(inst.id)}
              onFavorite={() => toggleFavorite(inst.id)}
              view={view}
            />
        ))}
        </div>
      ) : (
        <div className="empty search-empty">
          <Search size={28} />
          <h3>No matching instances</h3>
          <p>Try another search or clear the loader filter.</p>
          <button
            className="btn"
            onClick={() => {
              setQuery('')
              setLoader('all')
            }}
          >
            Clear filters
          </button>
        </div>
      )}
    </div>
  )
}
