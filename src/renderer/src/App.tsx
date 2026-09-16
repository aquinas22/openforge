import { useEffect, useState } from 'react'
import { ExternalLink, ShieldCheck, UserRound, X } from 'lucide-react'
import { useStore } from './store/store'
import { WorldBackground, Avatar, Logo } from './components/bits'
import { Console, Dock, Rail, TitleBar, Toasts } from './components/shell'
import { Library } from './pages/Library'
import { Discover } from './pages/Discover'
import { Settings } from './pages/Settings'
import { NewInstanceModal } from './pages/NewInstanceModal'
import { InstanceDetail } from './pages/InstanceDetail'

function AccountModal({ onClose }: { onClose: () => void }): JSX.Element {
  const account = useStore((s) => s.account)
  const settings = useStore((s) => s.settings)
  const saveSettings = useStore((s) => s.saveSettings)
  const saveAccount = useStore((s) => s.saveAccount)
  const toast = useStore((s) => s.toast)
  const [name, setName] = useState(account?.username ?? 'Player')
  const [working, setWorking] = useState(false)
  const valid = /^[A-Za-z0-9_]{1,16}$/.test(name)

  async function useOffline(): Promise<void> {
    if (!valid) return
    setWorking(true)
    if (name !== account?.username) await saveAccount(name)
    await saveSettings({ launchMode: 'offline' })
    toast('Offline play selected', 'success')
    onClose()
  }

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal account-modal" onClick={(e) => e.stopPropagation()}>
        <div className="between" style={{ marginBottom: 20 }}>
          <div>
            <div className="eyebrow">Identity</div>
            <h2 style={{ fontSize: 20 }}>Account & multiplayer</h2>
          </div>
          <button className="win-btn" onClick={onClose} aria-label="Close account menu">
            <X size={18} />
          </button>
        </div>

        <div className={`account-status ${settings?.launchMode === 'official' ? 'online' : ''}`}>
          <Avatar name={account?.username ?? 'Player'} size={48} />
          <div>
            <strong>{account?.username ?? 'Player'}</strong>
            <span>
              {settings?.launchMode === 'official' ? (
                <>
                  <i className="status-dot" /> Online through Minecraft Launcher
                </>
              ) : (
                'Offline profile · single-player and offline-mode servers'
              )}
            </span>
          </div>
        </div>

        <div className="account-section">
          <div className="account-section-head">
            <ShieldCheck size={17} />
            <div>
              <strong>Online play</strong>
              <span>Authentication is handled only by the official Minecraft Launcher.</span>
            </div>
          </div>

          <div className="account-setup">
            <div>
              <strong>{settings?.launchMode === 'official' ? 'Online mode selected' : 'Use official authentication'}</strong>
              <span>Openforge prepares the modded installation; Minecraft Launcher signs you in and starts it.</span>
            </div>
            <button
              className="btn primary sm"
              disabled={working}
              onClick={async () => {
                setWorking(true)
                await saveSettings({ launchMode: 'official' })
                toast('Online play selected', 'success')
                onClose()
              }}
            >
              <ExternalLink size={14} /> Use online
            </button>
          </div>
        </div>

        <div className="account-section">
          <div className="account-section-head">
            <UserRound size={17} />
            <div>
              <strong>Offline profile</strong>
              <span>For local worlds, LAN, and servers with online mode disabled.</span>
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
                {valid ? 'Letters, numbers, underscore · up to 16 characters' : 'Invalid offline name'}
              </div>
            </div>
            <button className="btn" disabled={!valid || working} onClick={useOffline}>
              Use offline
            </button>
          </div>
        </div>

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
        <div className="boot-progress"><i /></div>
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
  const setRoute = useStore((s) => s.setRoute)
  const openDetail = useStore((s) => s.openDetail)
  const openConsole = useStore((s) => s.openConsole)
  const [newOpen, setNewOpen] = useState(false)
  const [accountOpen, setAccountOpen] = useState(false)
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
        openDetail(null)
        openConsole(null)
        return
      }
      if (!(event.ctrlKey || event.metaKey)) return

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
  }, [openConsole, openDetail, setRoute])

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
      <InstanceDetail />
      <Toasts />
      {showSplash && <BootSplash leaving={splashLeaving} />}
    </>
  )
}
