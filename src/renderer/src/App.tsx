import { useEffect, useState } from 'react'
import { ShieldCheck, X } from 'lucide-react'
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
  const saveAccount = useStore((s) => s.saveAccount)
  const [name, setName] = useState(account?.username ?? 'Player')
  const valid = /^[A-Za-z0-9_]{1,16}$/.test(name)

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal" style={{ width: 'min(440px, 92vw)' }} onClick={(e) => e.stopPropagation()}>
        <div className="between" style={{ marginBottom: 20 }}>
          <h2 style={{ fontSize: 20 }}>Offline profile</h2>
          <button className="win-btn" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <div className="row" style={{ gap: 16, marginBottom: 20 }}>
          <div className="slot" style={{ padding: 4 }}>
            <Avatar name={valid ? name : 'Player'} size={72} />
          </div>
          <div style={{ flex: 1 }}>
            <input
              className="input"
              value={name}
              maxLength={16}
              onChange={(e) => setName(e.target.value)}
              style={!valid ? { boxShadow: 'inset 0 0 0 2px var(--danger)' } : undefined}
            />
            <div className="hint" style={{ marginTop: 7 }}>
              {valid ? 'Letters, numbers, underscore · up to 16 chars' : 'Invalid name'}
            </div>
          </div>
        </div>
        <div className="row" style={{ gap: 8, color: 'var(--muted)', fontSize: 12.5, marginBottom: 22 }}>
          <ShieldCheck size={15} style={{ color: 'var(--vein)', flexShrink: 0 }} />
          Ars Fodina plays offline with a deterministic UUID — no Microsoft account needed. Multiplayer
          on online-mode servers still requires a real account.
        </div>
        <div className="row" style={{ justifyContent: 'flex-end', gap: 10 }}>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={!valid}
            onClick={() => {
              saveAccount(name)
              onClose()
            }}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

export default function App(): JSX.Element {
  const ready = useStore((s) => s.ready)
  const route = useStore((s) => s.route)
  const init = useStore((s) => s.init)
  const theme = useStore((s) => s.settings?.theme)
  const uiStyle = useStore((s) => s.settings?.uiStyle)
  const [newOpen, setNewOpen] = useState(false)
  const [accountOpen, setAccountOpen] = useState(false)

  useEffect(() => {
    init()
  }, [init])

  // The theme lives on the root element; every token cascades from there.
  useEffect(() => {
    document.documentElement.dataset.theme = theme ?? 'terra'
  }, [theme])
  useEffect(() => {
    document.documentElement.dataset.uiStyle = uiStyle ?? 'modern'
  }, [uiStyle])

  return (
    <>
      <WorldBackground />
      <div className="app">
        <TitleBar />
        <div className="body-grid">
          <Rail onAccount={() => setAccountOpen(true)} />
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
    </>
  )
}
