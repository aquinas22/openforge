import { useEffect, useState } from 'react'
import {
  Check,
  ExternalLink,
  Gamepad2,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  UserRound,
  X
} from 'lucide-react'
import { useStore, type Route } from './store/store'
import { WorldBackground, Avatar, Logo } from './components/bits'
import { Console, Dock, Rail, TitleBar, Toasts } from './components/shell'
import { Library } from './pages/Library'
import { Discover } from './pages/Discover'
import { Servers } from './pages/Servers'
import { Settings } from './pages/Settings'
import { NewInstanceModal } from './pages/NewInstanceModal'
import { InstanceDetail } from './pages/InstanceDetail'
import { InstanceEditor } from './pages/InstanceEditor'

function AccountModal({ onClose }: { onClose: () => void }): JSX.Element {
  const accounts = useStore((s) => s.accounts)
  const playStatus = useStore((s) => s.playStatus)
  const launchMode = useStore((s) => s.settings?.launchMode)
  const addOfflineAccount = useStore((s) => s.addOfflineAccount)
  const setActiveAccount = useStore((s) => s.setActiveAccount)
  const removeAccount = useStore((s) => s.removeAccount)
  const refreshPlayStatus = useStore((s) => s.refreshPlayStatus)
  const openOfficialLauncher = useStore((s) => s.openOfficialLauncher)
  const saveSettings = useStore((s) => s.saveSettings)
  const toast = useStore((s) => s.toast)

  const [name, setName] = useState(playStatus?.offline.profileNames[0] ?? 'Player')
  const [checking, setChecking] = useState(false)
  const valid = /^[A-Za-z0-9_]{1,16}$/.test(name)
  const allowed = playStatus?.offline.allowed ?? false

  useEffect(() => {
    refreshPlayStatus()
  }, [refreshPlayStatus])

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal account-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="How you play">
        <div className="between" style={{ marginBottom: 18 }}>
          <div>
            <div className="eyebrow">Identity</div>
            <h2 style={{ fontSize: 20 }}>How you play</h2>
          </div>
          <button className="win-btn" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        {!playStatus ? (
          <div className="row muted" style={{ gap: 8, marginBottom: 16 }}>
            <Loader2 size={14} className="spin" /> Looking for a Minecraft Launcher account…
          </div>
        ) : allowed ? (
          <div className="notice accent play-gate">
            <ShieldCheck size={16} />
            <div>
              <strong>Offline play is ready</strong>
              <span>{playStatus.offline.reason}</span>
            </div>
          </div>
        ) : (
          <div className="notice warn play-gate">
            <TriangleAlert size={16} />
            <div>
              <strong>Offline play needs Minecraft on this PC</strong>
              <span>
                {playStatus.offline.reason} Openforge only starts the game offline where Minecraft: Java Edition
                has been bought: open the official Minecraft Launcher and sign in once with the account that owns
                it, then come back. Nothing is shared with Openforge except that an account exists.
              </span>
              <div className="row" style={{ gap: 8, marginTop: 10 }}>
                <button className="btn sm primary" onClick={() => openOfficialLauncher()}>
                  <ExternalLink size={14} /> Open Minecraft Launcher
                </button>
                <button
                  className="btn sm"
                  disabled={checking}
                  onClick={async () => {
                    setChecking(true)
                    await refreshPlayStatus()
                    setChecking(false)
                  }}
                >
                  {checking ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />} Check again
                </button>
              </div>
              {!playStatus.launcher.installed && (
                <small className="muted" style={{ marginTop: 6 }}>
                  The Minecraft Launcher does not seem to be installed; opening it takes you to the Microsoft Store.
                </small>
              )}
            </div>
          </div>
        )}

        <div className="account-section">
          <div className="account-section-head">
            <UserRound size={17} />
            <div>
              <strong>Offline profile</strong>
              <span>Openforge starts the game itself. Single-player, LAN, and servers with online mode off.</span>
            </div>
          </div>

          {accounts.length > 0 && (
            <div className="account-list">
              {accounts.map((account) => (
                <div key={account.id} className={`account-row${account.active ? ' active' : ''}`}>
                  <button
                    className="account-pick"
                    onClick={() => setActiveAccount(account.id)}
                    aria-pressed={account.active}
                  >
                    <Avatar name={account.username} size={36} />
                    <span className="account-meta">
                      <strong>{account.username}</strong>
                      <small>
                        <i className={`status-dot${allowed ? '' : ' offline'}`} />{' '}
                        {allowed ? 'Offline profile' : 'Offline profile · locked until a launcher account is found'}
                      </small>
                    </span>
                    {account.active && <Check size={16} className="account-check" />}
                  </button>
                  <button
                    className="win-btn"
                    title={`Remove ${account.username}`}
                    aria-label={`Remove ${account.username}`}
                    onClick={() => removeAccount(account.id)}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="row" style={{ gap: 12 }}>
            <Avatar name={valid ? name : 'Player'} size={40} />
            <div style={{ flex: 1 }}>
              <input
                className="input"
                value={name}
                maxLength={16}
                aria-label="Offline username"
                onChange={(e) => setName(e.target.value)}
                onKeyDown={async (e) => {
                  if (e.key === 'Enter' && valid) {
                    await addOfflineAccount(name)
                    toast(`Playing as ${name}`, 'success')
                  }
                }}
                style={!valid ? { boxShadow: 'inset 0 0 0 2px var(--danger)' } : undefined}
              />
              <div className="hint" style={{ marginTop: 6 }}>
                {valid
                  ? 'Letters, numbers, underscore, up to 16 characters. The same name always gets the same UUID, so worlds keep your inventory.'
                  : 'Use letters, numbers and underscore only (up to 16).'}
              </div>
            </div>
            <button
              className="btn"
              disabled={!valid}
              onClick={async () => {
                await addOfflineAccount(name)
                toast(`Playing as ${name}`, 'success')
              }}
            >
              {accounts.some((a) => a.username.toLowerCase() === name.toLowerCase()) ? 'Use' : 'Add'}
            </button>
          </div>
        </div>

        <div className="account-section">
          <div className="account-section-head">
            <Gamepad2 size={17} />
            <div>
              <strong>Minecraft Launcher</strong>
              <span>
                For online servers, Realms and your own skin. Openforge prepares the instance and hands it to the
                official launcher, which signs you in with Microsoft.
              </span>
            </div>
          </div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button className="btn sm" onClick={() => openOfficialLauncher()}>
              <ExternalLink size={14} /> Open Minecraft Launcher
            </button>
            {launchMode === 'official' ? (
              <button className="btn sm ghost" onClick={() => saveSettings({ launchMode: 'direct' })}>
                Play offline from Openforge instead
              </button>
            ) : (
              <button className="btn sm ghost" onClick={() => saveSettings({ launchMode: 'official' })}>
                Make Play use the Minecraft Launcher
              </button>
            )}
          </div>
          <div className="hint" style={{ marginTop: 8 }}>
            Play currently {launchMode === 'official' ? 'hands off to the Minecraft Launcher' : 'starts the game offline from Openforge'}.
            You can change this any time in Settings.
          </div>
        </div>
      </div>
    </div>
  )
}

const SHORTCUTS: [keys: string[], action: string][] = [
  [['Ctrl', 'Enter'], 'Play the most recent profile'],
  [['Ctrl', '1'], 'Library'],
  [['Ctrl', '2'], 'Discover'],
  [['Ctrl', '3'], 'Servers'],
  [['Ctrl', '4'], 'Settings'],
  [['Ctrl', 'K'], 'Search Discover'],
  [['Ctrl', 'N'], 'New instance'],
  [['Ctrl', 'L'], 'Show or hide the game console'],
  [['?'], 'Show these shortcuts'],
  [['Esc'], 'Close the open panel']
]

function ShortcutsModal({ onClose }: { onClose: () => void }): JSX.Element {
  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal shortcuts-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Keyboard shortcuts">
        <div className="between" style={{ marginBottom: 16 }}>
          <div>
            <div className="eyebrow">Keyboard</div>
            <h2 style={{ fontSize: 20 }}>Shortcuts</h2>
          </div>
          <button className="win-btn" onClick={onClose} aria-label="Close shortcuts">
            <X size={18} />
          </button>
        </div>
        <dl className="shortcut-list">
          {SHORTCUTS.map(([keys, action]) => (
            <div key={action}>
              <dt>
                {keys.map((key, i) => (
                  <span key={key}>
                    {i > 0 && ' + '}
                    <kbd>{key}</kbd>
                  </span>
                ))}
              </dt>
              <dd>{action}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  )
}

function BootSplash({ leaving }: { leaving: boolean }): JSX.Element {
  return (
    <div className={`boot-splash${leaving ? ' leaving' : ''}`} role="status" aria-label="Openforge is starting">
      <div className="boot-glow" />
      <div className="boot-brand">
        <div className="boot-mark">
          <Logo size={72} />
          <span className="boot-spark" />
        </div>
        <div className="eyebrow">Preparing your workshop</div>
        <h1>Openforge</h1>
        <p>Heating the forge</p>
        <div className="boot-progress">
          <i />
        </div>
      </div>
      <div className="boot-version">Minecraft, shaped your way.</div>
    </div>
  )
}

export default function App(): JSX.Element {
  const ready = useStore((s) => s.ready)
  const route = useStore((s) => s.route)
  const init = useStore((s) => s.init)
  const theme = useStore((s) => s.settings?.theme)
  const uiStyle = useStore((s) => s.settings?.uiStyle)
  const accounts = useStore((s) => s.accounts)
  const setRoute = useStore((s) => s.setRoute)
  const openDetail = useStore((s) => s.openDetail)
  const openConsole = useStore((s) => s.openConsole)
  const accountOpen = useStore((s) => s.accountsOpen)
  const setAccountOpen = useStore((s) => s.setAccountsOpen)
  const shortcutsOpen = useStore((s) => s.shortcutsOpen)
  const setShortcutsOpen = useStore((s) => s.setShortcutsOpen)
  const [newOpen, setNewOpen] = useState(false)
  const [showSplash, setShowSplash] = useState(true)
  const [splashLeaving, setSplashLeaving] = useState(false)

  useEffect(() => {
    init()
  }, [init])

  useEffect(() => {
    if (!ready) return
    const leave = window.setTimeout(() => setSplashLeaving(true), 700)
    const remove = window.setTimeout(() => setShowSplash(false), 1150)
    return () => {
      window.clearTimeout(leave)
      window.clearTimeout(remove)
    }
  }, [ready])

  // A launcher with no account cannot play anything, so say so immediately
  // rather than at the moment someone presses Play.
  useEffect(() => {
    if (ready && accounts.length === 0) setAccountOpen(true)
  }, [ready, accounts.length, setAccountOpen])

  // The theme lives on the root element; every token cascades from there.
  useEffect(() => {
    document.documentElement.dataset.theme = theme ?? 'terra'
  }, [theme])
  useEffect(() => {
    document.documentElement.dataset.uiStyle = uiStyle ?? 'modern'
  }, [uiStyle])

  // A file dropped anywhere but a drop target would make Electron navigate to
  // it, replacing the whole app. Only the content tabs accept drops.
  useEffect(() => {
    const block = (event: DragEvent): void => {
      if (event.defaultPrevented) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'none'
    }
    window.addEventListener('dragover', block)
    window.addEventListener('drop', block)
    return () => {
      window.removeEventListener('dragover', block)
      window.removeEventListener('drop', block)
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      const isTyping =
        target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.tagName === 'SELECT'

      if (event.key === 'Escape') {
        // The editor sits above everything else; close it on its own first.
        if (useStore.getState().editorFor) {
          useStore.getState().openEditor(null)
          return
        }
        setNewOpen(false)
        setAccountOpen(false)
        setShortcutsOpen(false)
        openDetail(null)
        openConsole(null)
        return
      }
      if (event.key === '?' && !isTyping && !event.ctrlKey && !event.metaKey) {
        event.preventDefault()
        setShortcutsOpen(true)
        return
      }
      if (!(event.ctrlKey || event.metaKey)) return

      const state = useStore.getState()
      if (event.key === 'Enter' && !isTyping) {
        // Play whatever was played last, the way the Library hero suggests.
        const recent = [...state.instances].sort(
          (a, b) =>
            new Date(b.lastPlayed ?? b.createdAt).getTime() - new Date(a.lastPlayed ?? a.createdAt).getTime()
        )[0]
        if (recent && !state.running[recent.id] && !state.busy[recent.id]) {
          event.preventDefault()
          state.launch(recent.id)
        }
        return
      }
      if (event.key.toLowerCase() === 'l' && !isTyping) {
        event.preventDefault()
        const active =
          Object.keys(state.busy).find((id) => state.busy[id]) ??
          Object.keys(state.running).find((id) => state.running[id]) ??
          state.detailInstance
        openConsole(state.consoleFor ? null : active ?? null)
        return
      }

      const routes: Record<string, Route> = { '1': 'library', '2': 'discover', '3': 'servers', '4': 'settings' }
      if (routes[event.key]) {
        event.preventDefault()
        setRoute(routes[event.key])
      } else if (event.key.toLowerCase() === 'n' && !isTyping) {
        event.preventDefault()
        setNewOpen(true)
      } else if (event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setRoute('discover')
        window.setTimeout(() => document.getElementById('discover-search')?.focus(), 0)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [openConsole, openDetail, setRoute, setAccountOpen, setShortcutsOpen])

  return (
    <>
      <WorldBackground />
      <div className="app">
        <TitleBar />
        <div className="body-grid">
          <Rail onAccount={() => setAccountOpen(true)} onNew={() => setNewOpen(true)} />
          <div className="content">
            {!ready ? (
              <div className="empty" style={{ paddingTop: 140 }}>
                <Logo size={44} />
                <p style={{ marginTop: 16 }}>Opening the mine…</p>
              </div>
            ) : route === 'library' ? (
              <Library onNew={() => setNewOpen(true)} />
            ) : route === 'discover' ? (
              <Discover />
            ) : route === 'servers' ? (
              <Servers />
            ) : (
              <Settings />
            )}
          </div>
          <Dock />
          <Console />
        </div>
      </div>

      {newOpen && <NewInstanceModal onClose={() => setNewOpen(false)} />}
      {accountOpen && <AccountModal onClose={() => setAccountOpen(false)} />}
      {shortcutsOpen && <ShortcutsModal onClose={() => setShortcutsOpen(false)} />}
      <InstanceDetail />
      <InstanceEditor />
      <Toasts />
      {showSplash && <BootSplash leaving={splashLeaving} />}
    </>
  )
}
