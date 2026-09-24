import { useEffect, useState } from 'react'
import {
  Check,
  Copy,
  ExternalLink,
  Loader2,
  LogIn,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  UserRound,
  X
} from 'lucide-react'
import { useStore } from './store/store'
import { api } from './api'
import { WorldBackground, Avatar, Logo } from './components/bits'
import { Console, Dock, Rail, TitleBar, Toasts } from './components/shell'
import { Library } from './pages/Library'
import { Discover } from './pages/Discover'
import { Settings } from './pages/Settings'
import { NewInstanceModal } from './pages/NewInstanceModal'
import { InstanceDetail } from './pages/InstanceDetail'

function AccountModal({ onClose }: { onClose: () => void }): JSX.Element {
  const accounts = useStore((s) => s.accounts)
  const settings = useStore((s) => s.settings)
  const authPrompt = useStore((s) => s.authPrompt)
  const authBusy = useStore((s) => s.authBusy)
  const addOfflineAccount = useStore((s) => s.addOfflineAccount)
  const setActiveAccount = useStore((s) => s.setActiveAccount)
  const removeAccount = useStore((s) => s.removeAccount)
  const startMicrosoftLogin = useStore((s) => s.startMicrosoftLogin)
  const cancelMicrosoftLogin = useStore((s) => s.cancelMicrosoftLogin)
  const setRoute = useStore((s) => s.setRoute)
  const toast = useStore((s) => s.toast)

  const [name, setName] = useState('Player')
  const valid = /^[A-Za-z0-9_]{1,16}$/.test(name)
  const hasClientId = Boolean(settings?.msClientId)

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal account-modal" onClick={(e) => e.stopPropagation()}>
        <div className="between" style={{ marginBottom: 20 }}>
          <div>
            <div className="eyebrow">Identity</div>
            <h2 style={{ fontSize: 20 }}>Accounts</h2>
          </div>
          <button className="win-btn" onClick={onClose} aria-label="Close account menu">
            <X size={18} />
          </button>
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
                  {account.avatarUrl ? (
                    <img className="account-skin" src={account.avatarUrl} alt="" width={40} height={40} />
                  ) : (
                    <Avatar name={account.username} size={40} />
                  )}
                  <span className="account-meta">
                    <strong>{account.username}</strong>
                    <small>
                      {account.kind === 'microsoft' ? (
                        account.needsReauth ? (
                          <>
                            <TriangleAlert size={11} /> Sign in again
                          </>
                        ) : account.entitled === false ? (
                          <>
                            <TriangleAlert size={11} /> No Java Edition licence
                          </>
                        ) : (
                          <>
                            <i className="status-dot" /> Microsoft · online play
                          </>
                        )
                      ) : (
                        <>
                          <i className="status-dot offline" /> Offline profile
                        </>
                      )}
                    </small>
                  </span>
                  {account.active && <Check size={16} className="account-check" />}
                </button>
                <button
                  className="win-btn"
                  title={`Remove ${account.username}`}
                  onClick={() => removeAccount(account.id)}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="account-section">
          <div className="account-section-head">
            <ShieldCheck size={17} />
            <div>
              <strong>Microsoft account</strong>
              <span>Required for online-mode servers, Realms, and your real skin.</span>
            </div>
          </div>

          {authPrompt ? (
            <div className="device-code">
              <p className="dim">
                Open the page below and enter this code. Openforge finishes the sign-in on its own.
              </p>
              <div className="device-code-value">
                <code>{authPrompt.userCode}</code>
                <button
                  className="btn sm"
                  onClick={() => {
                    navigator.clipboard.writeText(authPrompt.userCode).catch(() => undefined)
                    toast('Code copied', 'success')
                  }}
                >
                  <Copy size={14} /> Copy
                </button>
              </div>
              <div className="row" style={{ gap: 8 }}>
                <button className="btn primary" onClick={() => api.openExternal(authPrompt.verificationUri)}>
                  <ExternalLink size={14} /> Open sign-in page
                </button>
                <button className="btn ghost" onClick={() => cancelMicrosoftLogin()}>
                  Cancel
                </button>
              </div>
              <div className="row muted" style={{ gap: 8, marginTop: 10, fontSize: 12 }}>
                <Loader2 size={13} className="spin" /> Waiting for you to finish in the browser…
              </div>
            </div>
          ) : hasClientId ? (
            <div className="account-setup">
              <div>
                <strong>Sign in with Microsoft</strong>
                <span>
                  A code appears here; you enter it once in your browser. Openforge never sees your
                  password, and the session is stored encrypted by Windows.
                </span>
              </div>
              <button className="btn primary sm" disabled={authBusy} onClick={() => startMicrosoftLogin()}>
                {authBusy ? <Loader2 size={14} className="spin" /> : <LogIn size={14} />} Sign in
              </button>
            </div>
          ) : (
            <div className="account-setup">
              <div>
                <strong>Needs an application ID first</strong>
                <span>
                  Microsoft grants Minecraft sign-in only to a registered app. Add your own Azure
                  client ID in Settings, or keep using the Minecraft Launcher hand-off for online play.
                </span>
              </div>
              <button
                className="btn sm"
                onClick={() => {
                  setRoute('settings')
                  onClose()
                }}
              >
                Open settings
              </button>
            </div>
          )}
        </div>

        <div className="account-section">
          <div className="account-section-head">
            <UserRound size={17} />
            <div>
              <strong>Offline profile</strong>
              <span>For single-player, LAN, and servers with online mode disabled.</span>
            </div>
          </div>
          <div className="row" style={{ gap: 12 }}>
            <Avatar name={valid ? name : 'Player'} size={44} />
            <div style={{ flex: 1 }}>
              <input
                className="input"
                value={name}
                maxLength={16}
                onChange={(e) => setName(e.target.value)}
                style={!valid ? { boxShadow: 'inset 0 0 0 2px var(--danger)' } : undefined}
              />
              <div className="hint" style={{ marginTop: 6 }}>
                {valid
                  ? 'Letters, numbers, underscore · up to 16 characters'
                  : 'Invalid offline name'}
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
              Add
            </button>
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
  [['Ctrl', '3'], 'Settings'],
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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      const isTyping =
        target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.tagName === 'SELECT'

      if (event.key === 'Escape') {
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

      if (event.key === '1' || event.key === '2' || event.key === '3') {
        event.preventDefault()
        setRoute(event.key === '1' ? 'library' : event.key === '2' ? 'discover' : 'settings')
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
      <Toasts />
      {showSplash && <BootSplash leaving={splashLeaving} />}
    </>
  )
}
