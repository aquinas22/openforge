import { useEffect, useRef } from 'react'
import { Minus, Square, Terminal, X, Loader2, CircleStop, Plus, Check, Keyboard } from 'lucide-react'
import { LAUNCH_STEPS, type LaunchStep } from '@shared/types'
import { useShallow } from 'zustand/react/shallow'
import { api } from '../api'
import { useStore, type Route } from '../store/store'
import { Avatar, Logo, Sprite, sprites } from './bits'

/** What pressing Play will do, in a few words, for the title bar and the rail. */
function usePlayIdentity(): { text: string; ok: boolean; known: boolean } {
  const account = useStore((s) => s.accounts.find((entry) => entry.active))
  const launchMode = useStore((s) => s.settings?.launchMode)
  const playStatus = useStore((s) => s.playStatus)
  if (launchMode === 'official') return { text: 'Via Minecraft Launcher', ok: true, known: true }
  if (!playStatus) return { text: account ? 'Offline profile' : 'No profile yet', ok: false, known: false }
  if (!playStatus.offline.allowed) return { text: 'Launcher account needed', ok: false, known: true }
  return { text: account ? 'Offline play' : 'No profile yet', ok: Boolean(account), known: true }
}

export function TitleBar(): JSX.Element {
  const setShortcutsOpen = useStore((s) => s.setShortcutsOpen)
  const setAccountsOpen = useStore((s) => s.setAccountsOpen)
  const account = useStore((s) => s.accounts.find((entry) => entry.active))
  const identity = usePlayIdentity()
  return (
    <div className="titlebar">
      <div className="brand row">
        <Logo size={24} />
        <span>Openforge</span>
        <small>Minecraft launcher</small>
      </div>
      <div className="spacer" />
      {identity.known && (
        <button
          className={`titlebar-play${identity.ok ? '' : ' warn'}`}
          onClick={() => setAccountsOpen(true)}
          title="How you play"
        >
          <i className={`status-dot${identity.ok ? '' : ' offline'}`} />
          {identity.text}
          {identity.ok && account && identity.text === 'Offline play' ? <strong>{account.username}</strong> : null}
        </button>
      )}
      <div className="win-controls">
        <button className="win-btn" title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts" onClick={() => setShortcutsOpen(true)}>
          <Keyboard size={15} />
        </button>
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
  { key: 'servers', label: 'Servers', sprite: sprites.furnace },
  { key: 'settings', label: 'Settings', sprite: sprites.pickaxe }
]

const NAV_DETAIL: Record<Route, string> = {
  library: 'Your instances',
  discover: 'Packs, mods & textures',
  servers: 'Local and SSH hosting',
  settings: 'Launcher setup'
}

export function Rail({ onAccount, onNew }: { onAccount: () => void; onNew: () => void }): JSX.Element {
  const route = useStore((s) => s.route)
  const setRoute = useStore((s) => s.setRoute)
  const account = useStore((s) => s.accounts.find((entry) => entry.active))
  // What the player is about to launch as, in three words.
  const { text: identity, ok: online } = usePlayIdentity()
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
      <button className="rail-account" onClick={onAccount} title="How you play">
        <span className="rail-avatar">
          <Avatar name={account?.username ?? 'Player'} size={40} />
        </span>
        <span className="rail-copy">
          <strong>{account?.username ?? 'Pick a name'}</strong>
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
  const nameOf = (id: string): string =>
    id === 'java' ? 'Java runtime' : instances.find((i) => i.id === id)?.name ?? 'Instance'

  if (!busyId && runningIds.length === 0) return null

  if (busyId) {
    const p = progress[busyId]
    const pct = p && p.progress >= 0 ? Math.round(p.progress * 100) : 0
    const indeterminate = !p || p.progress < 0
    return (
      <div className="dock">
        <Loader2 size={18} className="spin" style={{ color: 'var(--vein)' }} />
        <div className="dock-copy">
          <div style={{ fontWeight: 600, fontSize: 13 }}>
            {nameOf(busyId)} · <span className="muted">{p?.label ?? 'Working'}</span>
          </div>
          <div className="muted dock-detail">{p?.detail ?? ''}</div>
        </div>
        {p?.step ? (
          <LaunchSteps step={p.step} />
        ) : (
          <div className={`dock-bar${indeterminate ? ' indeterminate' : ''}`}>
            <span style={{ width: `${pct}%` }} />
          </div>
        )}
        {!indeterminate && !p?.step && (
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
  const p = progress[id]
  const starting = p?.step && p.step !== 'ready'
  return (
    <div className="dock">
      <span className="chip accent">
        <span className={`live-dot${starting ? ' pulsing' : ''}`} />
        {starting ? p?.label ?? 'Starting' : 'Playing'}
      </span>
      <div style={{ fontWeight: 600 }}>{nameOf(id)}</div>
      {runningIds.length > 1 && <span className="muted">+{runningIds.length - 1} more</span>}
      {starting && p?.step && <LaunchSteps step={p.step} />}
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

/** The launch sequence as a row of small steps: done, current, and to come. */
export function LaunchSteps({ step }: { step: LaunchStep }): JSX.Element {
  const current = LAUNCH_STEPS.findIndex((entry) => entry.key === step)
  return (
    <ol className="launch-steps" aria-label="Launch progress">
      {LAUNCH_STEPS.map((entry, index) => {
        const state = index < current ? 'done' : index === current ? 'current' : 'todo'
        return (
          <li key={entry.key} className={state} aria-current={state === 'current' ? 'step' : undefined}>
            <i>{state === 'done' ? <Check size={10} strokeWidth={3} /> : null}</i>
            <span>{entry.label}</span>
          </li>
        )
      })}
    </ol>
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
  const runFix = useStore((s) => s.runFix)
  return (
    <div className="toast-wrap" role="status" aria-live="polite">
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
          <div className="toast-body">
            {t.title && <strong>{t.title}</strong>}
            <div>{t.message}</div>
            {t.action && (
              <button
                className="btn sm toast-action"
                onClick={(event) => {
                  event.stopPropagation()
                  dismiss(t.id)
                  runFix(t.action!.fix, t.action!.instanceId)
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}
