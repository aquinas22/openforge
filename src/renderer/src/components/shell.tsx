import { useEffect, useRef } from 'react'
import { Minus, Square, Terminal, X, Loader2, CircleStop, Plus } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { api } from '../api'
import { useStore, type Route } from '../store/store'
import { Avatar, Logo, Sprite, sprites } from './bits'

export function TitleBar(): JSX.Element {
  return (
    <div className="titlebar">
      <div className="brand row">
        <Logo size={24} />
        <span>Openforge</span>
        <small>Minecraft launcher</small>
      </div>
      <div className="spacer" />
      <div className="win-controls">
        <button className="win-btn" title="Minimize" onClick={() => api.minimizeWindow()}>
          <Minus size={15} />
        </button>
        <button className="win-btn" title="Maximize" onClick={() => api.toggleMaximizeWindow()}>
          <Square size={12} />
        </button>
        <button className="win-btn close" title="Close" onClick={() => api.closeWindow()}>
          <X size={15} />
        </button>
      </div>
    </div>
  )
}

// Each destination gets the tool you would reach for: your chest, a compass, a pickaxe.
const NAV: { key: Route; label: string; sprite: string }[] = [
  { key: 'library', label: 'Library', sprite: sprites.chest },
  { key: 'discover', label: 'Discover', sprite: sprites.compass },
  { key: 'settings', label: 'Settings', sprite: sprites.pickaxe }
]

const NAV_DETAIL: Record<Route, string> = {
  library: 'Your instances',
  discover: 'Packs, mods & textures',
  settings: 'Launcher setup'
}

export function Rail({ onAccount, onNew }: { onAccount: () => void; onNew: () => void }): JSX.Element {
  const route = useStore((s) => s.route)
  const setRoute = useStore((s) => s.setRoute)
  const account = useStore((s) => s.accounts.find((entry) => entry.active))
  const launchMode = useStore((s) => s.settings?.launchMode)
  // What the player is about to launch as, in three words.
  const identity = !account
    ? 'No account yet'
    : launchMode === 'official'
      ? 'Via Minecraft Launcher'
      : account.kind === 'microsoft'
        ? account.needsReauth
          ? 'Sign in again'
          : 'Microsoft · online'
        : 'Offline profile'
  const online = Boolean(account && (launchMode === 'official' || (account.kind === 'microsoft' && !account.needsReauth)))
  return (
    <nav className="rail">
      <div className="rail-section-label">Workspace</div>
      {NAV.map((n) => (
        <button
          key={n.key}
          className={`rail-item${route === n.key ? ' active' : ''}`}
          onClick={() => setRoute(n.key)}
          aria-label={n.label}
          aria-current={route === n.key ? 'page' : undefined}
        >
          <Sprite src={n.sprite} size={28} />
          <span className="rail-copy">
            <strong>{n.label}</strong>
            <small>{NAV_DETAIL[n.key]}</small>
          </span>
          <span className="tip">{n.label}</span>
        </button>
      ))}
      <button className="rail-new" onClick={onNew}>
        <span className="rail-new-icon">
          <Plus size={17} />
        </span>
        <span className="rail-copy">
          <strong>New instance</strong>
          <small>Ctrl + N</small>
        </span>
      </button>
      <div className="rail-spacer" />
      <button className="rail-account" onClick={onAccount} title="Manage accounts">
        <span className="rail-avatar">
          {account?.avatarUrl ? (
            <img src={account.avatarUrl} alt="" width={40} height={40} className="account-skin" />
          ) : (
            <Avatar name={account?.username ?? 'Player'} size={40} />
          )}
        </span>
        <span className="rail-copy">
          <strong>{account?.username ?? 'Add an account'}</strong>
          <small>
            <i className={`status-dot${online ? '' : ' offline'}`} /> {identity}
          </small>
        </span>
      </button>
    </nav>
  )
}

export function Dock(): JSX.Element | null {
  const { progress, busy, running, instances, consoleFor } = useStore(
    useShallow((s) => ({
      progress: s.progress,
      busy: s.busy,
      running: s.running,
      instances: s.instances,
      consoleFor: s.consoleFor
    }))
  )
  const openConsole = useStore((s) => s.openConsole)
  const kill = useStore((s) => s.kill)

  const busyId = Object.keys(busy).find((id) => busy[id])
  const runningIds = Object.keys(running).filter((id) => running[id])
  const nameOf = (id: string): string => instances.find((i) => i.id === id)?.name ?? 'Instance'

  if (!busyId && runningIds.length === 0) return null

  if (busyId) {
    const p = progress[busyId]
    const pct = p && p.progress >= 0 ? Math.round(p.progress * 100) : 0
    const indeterminate = !p || p.progress < 0
    return (
      <div className="dock">
        <Loader2 size={18} className="spin" style={{ color: 'var(--vein)' }} />
        <div style={{ minWidth: 220 }}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>
            {nameOf(busyId)} · <span className="muted">{p?.label ?? 'Working'}</span>
          </div>
          <div className="muted" style={{ fontSize: 11.5 }}>
            {p?.detail ?? ''}
          </div>
        </div>
        <div className={`dock-bar${indeterminate ? ' indeterminate' : ''}`}>
          <span style={{ width: `${pct}%` }} />
        </div>
        {!indeterminate && (
          <span className="muted" style={{ fontVariantNumeric: 'tabular-nums' }}>
            {pct}%
          </span>
        )}
        <button className="btn sm ghost" onClick={() => openConsole(consoleFor ? null : busyId)}>
          <Terminal size={15} /> Console
        </button>
      </div>
    )
  }

  const id = runningIds[0]
  return (
    <div className="dock">
      <span className="chip accent">
        <span style={{ width: 8, height: 8, background: 'var(--vein)' }} />
        Running
      </span>
      <div style={{ fontWeight: 600 }}>{nameOf(id)}</div>
      {runningIds.length > 1 && <span className="muted">+{runningIds.length - 1} more</span>}
      <div className="spacer" style={{ flex: 1 }} />
      <button className="btn sm ghost" onClick={() => openConsole(consoleFor ? null : id)}>
        <Terminal size={15} /> Console
      </button>
      <button className="btn sm danger" onClick={() => kill(id)}>
        <CircleStop size={15} /> Stop
      </button>
    </div>
  )
}

export function Console(): JSX.Element | null {
  const consoleFor = useStore((s) => s.consoleFor)
  const logs = useStore((s) => (consoleFor ? s.logs[consoleFor] : undefined))
  const instances = useStore((s) => s.instances)
  const openConsole = useStore((s) => s.openConsole)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [logs])

  if (!consoleFor) return null
  const name = instances.find((i) => i.id === consoleFor)?.name ?? 'Instance'
  return (
    <div className="console">
      <div className="between" style={{ padding: '10px 16px', borderBottom: '3px solid var(--rule)' }}>
        <div className="row">
          <Terminal size={16} style={{ color: 'var(--vein)' }} />
          <strong style={{ fontSize: 13 }}>{name}</strong>
          <span className="muted" style={{ fontSize: 12 }}>
            · game log
          </span>
        </div>
        <button className="win-btn" onClick={() => openConsole(null)}>
          <X size={16} />
        </button>
      </div>
      <div className="console-lines" ref={ref}>
        {(logs ?? []).length === 0 ? (
          <div className="muted">Waiting for output…</div>
        ) : (
          (logs ?? []).map((l, i) => (
            <div key={i} className={`l-${l.stream}`}>
              {l.line}
            </div>
          ))
        )}
      </div>
    </div>
  )
}

export function Toasts(): JSX.Element {
  const toasts = useStore((s) => s.toasts)
  const dismiss = useStore((s) => s.dismissToast)
  return (
    <div className="toast-wrap">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} onClick={() => dismiss(t.id)}>
          <span
            style={{
              width: 8,
              height: 8,
              marginTop: 6,
              flexShrink: 0,
              background:
                t.kind === 'error' ? '#fff' : t.kind === 'success' ? 'var(--vein)' : 'var(--dim)'
            }}
          />
          <div style={{ fontSize: 13 }}>{t.message}</div>
        </div>
      ))}
    </div>
  )
}
