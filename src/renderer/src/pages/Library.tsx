import { Boxes, Clock, Folder, Play, Plus, Loader2, CircleStop, Sparkles, Download } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { api } from '../api'
import { useStore } from '../store/store'
import type { Instance } from '@shared/types'
import { loaderLabel, playtime, timeAgo } from '../util'
import { Sprite, blockFor, sprites } from '../components/bits'

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
          <button className="btn ghost" onClick={() => openConsole(inst.id)}>
            View log
          </button>
        </div>
      </div>
    </div>
  )
}

function InstanceCard({ inst }: { inst: Instance }): JSX.Element {
  const st = useInstState(inst.id)
  const openDetail = useStore((s) => s.openDetail)
  const pct = st.progress && st.progress >= 0 ? Math.round(st.progress * 100) : null

  return (
    <div
      className="panel card-instance"
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
        {inst.loaderPending && (
          <span className="chip warn" style={{ position: 'absolute', top: 8, right: 8 }}>
            Loader pending
          </span>
        )}
      </div>
      <div style={{ padding: '12px 14px 14px' }}>
        <div style={{ fontWeight: 600, marginBottom: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {inst.name}
        </div>
        <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
          {inst.mcVersion} · {inst.installed ? `played ${timeAgo(inst.lastPlayed)}` : 'not installed'}
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

  if (instances.length === 0) {
    return (
      <div className="page">
        <div className="empty" style={{ paddingTop: 90 }}>
          <Sprite src={sprites.chest} size={72} />
          <h2 style={{ fontSize: 24, marginBottom: 8 }}>Your library is empty</h2>
          <p style={{ maxWidth: 420, margin: '0 auto 22px' }}>
            Create a vanilla or Fabric instance, or install a modpack from CurseForge. Everything runs
            offline — no account required.
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

  const sorted = [...instances].sort(
    (a, b) => new Date(b.lastPlayed ?? b.createdAt).getTime() - new Date(a.lastPlayed ?? a.createdAt).getTime()
  )
  const featured = sorted[0]

  return (
    <div className="page">
      <Hero inst={featured} />
      <div className="page-head" style={{ marginBottom: 16 }}>
        <div>
          <div className="eyebrow">Library</div>
          <h2 className="page-title" style={{ fontSize: 22 }}>
            {instances.length} instance{instances.length === 1 ? '' : 's'}
          </h2>
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
      <div className="grid-cards">
        {sorted.map((inst) => (
          <InstanceCard key={inst.id} inst={inst} />
        ))}
      </div>
    </div>
  )
}
