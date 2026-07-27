import { useEffect, useState } from 'react'
import { Check, FolderOpen, Cpu, HardDrive, MemoryStick, Package, RefreshCw, User, Palette } from 'lucide-react'
import { api } from '../api'
import { useStore } from '../store/store'
import type { Settings as SettingsType, ThemeId, UiStyle } from '@shared/types'
import { Avatar, Sprite, themeBlock } from '../components/bits'

/** Biome themes, named for the layer of the world they are cut from. */
const THEMES: { id: ThemeId; name: string; latin: string }[] = [
  { id: 'terra', name: 'Overworld', latin: 'Terra Viridis' },
  { id: 'infernum', name: 'Nether', latin: 'Infernum' },
  { id: 'finis', name: 'The End', latin: 'Finis' },
  { id: 'tenebrae', name: 'Deep Dark', latin: 'Tenebrae' },
  { id: 'glacies', name: 'Snowy', latin: 'Glacies' },
  { id: 'lux', name: 'Daylight', latin: 'Lux' }
]

function Section({ icon, title, children }: { icon: JSX.Element; title: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="panel" style={{ padding: 22, marginBottom: 18 }}>
      <div className="row" style={{ gap: 9, marginBottom: 18 }}>
        <span style={{ color: 'var(--vein)' }}>{icon}</span>
        <h3 style={{ fontSize: 16 }}>{title}</h3>
      </div>
      {children}
    </div>
  )
}

function Toggle({ on, onClick }: { on: boolean; onClick: () => void }): JSX.Element {
  return <button className={`toggle${on ? ' on' : ''}`} onClick={onClick} aria-pressed={on} />
}

export function Settings(): JSX.Element {
  const settings = useStore((s) => s.settings)
  const account = useStore((s) => s.account)
  const java = useStore((s) => s.java)
  const refreshJava = useStore((s) => s.refreshJava)
  const saveSettings = useStore((s) => s.saveSettings)
  const saveAccount = useStore((s) => s.saveAccount)
  const toast = useStore((s) => s.toast)

  const [form, setForm] = useState<SettingsType | null>(settings)
  const [name, setName] = useState(account?.username ?? 'Player')

  useEffect(() => setForm(settings), [settings])
  useEffect(() => setName(account?.username ?? 'Player'), [account])

  if (!form) return <div className="page" />
  const set = <K extends keyof SettingsType>(k: K, v: SettingsType[K]): void => setForm({ ...form, [k]: v })
  const nameValid = /^[A-Za-z0-9_]{1,16}$/.test(name)

  async function saveAll(): Promise<void> {
    if (nameValid && name !== account?.username) await saveAccount(name)
    if (form) await saveSettings(form)
    toast('Settings saved', 'success')
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="eyebrow">Preferences</div>
          <h1 className="page-title">Settings</h1>
        </div>
        <button className="btn primary" onClick={saveAll}>
          <Check size={16} /> Save changes
        </button>
      </div>

      <Section icon={<User size={18} />} title="Offline profile">
        <div className="row" style={{ gap: 16, alignItems: 'flex-start' }}>
          <div className="slot" style={{ padding: 4 }}>
            <Avatar name={nameValid ? name : 'Player'} size={64} />
          </div>
          <div style={{ flex: 1 }}>
            <div className="field" style={{ marginBottom: 0 }}>
              <label>Player name</label>
              <input
                className="input"
                value={name}
                maxLength={16}
                onChange={(e) => setName(e.target.value)}
                style={!nameValid ? { boxShadow: 'inset 0 0 0 2px var(--danger)' } : undefined}
              />
              <div className="hint">
                {nameValid
                  ? 'Used for your offline identity and world saves. A stable UUID is derived from it.'
                  : '1–16 characters: letters, numbers, and underscore only.'}
              </div>
            </div>
          </div>
        </div>
      </Section>

      <Section icon={<Palette size={18} />} title="Appearance">
        <div className="field">
          <label>Interface style</label>
          <div className="style-picker">
            {([
              ['modern', 'Modern', 'Softer cards, calmer shadows, and roomier controls'],
              ['classic', 'Classic', 'Square inventory panels and strong pixel bevels']
            ] as [UiStyle, string, string][]).map(([id, title, detail]) => (
              <button
                key={id}
                className={`style-card${form.uiStyle === id ? ' active' : ''}`}
                onClick={() => set('uiStyle', id)}
                aria-pressed={form.uiStyle === id}
              >
                <span className={`style-preview ${id}`} aria-hidden="true">
                  <i /><i /><i />
                </span>
                <span>
                  <strong>{title}</strong>
                  <small>{detail}</small>
                </span>
              </button>
            ))}
          </div>
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label>Theme</label>
          <div className="theme-grid">
            {THEMES.map((t) => (
              <button
                key={t.id}
                className={`theme-card${form?.theme === t.id ? ' active' : ''}`}
                data-theme={t.id}
                onClick={() => set('theme', t.id)}
                aria-pressed={form?.theme === t.id}
              >
                <span className="theme-swatch slot">
                  <Sprite src={themeBlock[t.id]} size={32} />
                </span>
                <span className="theme-name">{t.name}</span>
                <span className="theme-latin">{t.latin}</span>
              </button>
            ))}
          </div>
          <div className="hint">Each theme repaints the accent and the banner behind the app.</div>
        </div>
      </Section>

      <Section icon={<Cpu size={18} />} title="Java runtime">
        <div className="field">
          <label>Java executable</label>
          <div className="input-row">
            <select
              className="select"
              value={form.javaPath}
              onChange={(e) => set('javaPath', e.target.value)}
              style={{ flex: 1 }}
            >
              <option value="">Auto-detect best runtime</option>
              {java.map((j) => (
                <option key={j.path} value={j.path}>
                  Java {j.majorVersion} ({j.version}) — {j.path}
                </option>
              ))}
            </select>
            <button className="btn icon" title="Rescan" onClick={refreshJava}>
              <RefreshCw size={15} />
            </button>
            <button
              className="btn"
              onClick={async () => {
                const dir = await api.pickDirectory()
                if (dir) set('javaPath', dir)
              }}
            >
              Browse
            </button>
          </div>
          <div className="hint">
            {java.length
              ? `Found ${java.length} runtime${java.length === 1 ? '' : 's'}: Java ${java
                  .map((j) => j.majorVersion)
                  .join(', ')}. Ars Fodina picks the version each Minecraft build asks for.`
              : 'No Java found yet. Install a JDK (Adoptium/Temurin) and rescan.'}
          </div>
        </div>
      </Section>

      <Section icon={<MemoryStick size={18} />} title="Performance">
        <div className="field">
          <div className="between" style={{ marginBottom: 8 }}>
            <label style={{ margin: 0 }}>Allocated memory</label>
            <span className="chip accent">{(form.ramMb / 1024).toFixed(1)} GB</span>
          </div>
          <input
            className="slider"
            type="range"
            min={1024}
            max={65536}
            step={512}
            value={form.ramMb}
            onChange={(e) => set('ramMb', Number(e.target.value))}
          />
          <div className="between hint" style={{ marginTop: 6 }}>
            <span>1 GB</span>
            <span>64 GB</span>
          </div>
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label>JVM arguments</label>
          <textarea
            className="input"
            rows={3}
            value={form.jvmArgs}
            onChange={(e) => set('jvmArgs', e.target.value)}
          />
          <div className="hint">Advanced. The defaults are tuned G1GC flags that work well for modded packs.</div>
        </div>
      </Section>

      <Section icon={<HardDrive size={18} />} title="Game & window">
        <div className="field">
          <label>Game directory</label>
          <div className="input-row">
            <input className="input" value={form.gameDir} onChange={(e) => set('gameDir', e.target.value)} style={{ flex: 1 }} />
            <button
              className="btn"
              onClick={async () => {
                const dir = await api.pickDirectory()
                if (dir) set('gameDir', dir)
              }}
            >
              Browse
            </button>
            <button className="btn icon" title="Open folder" onClick={() => api.openFolder(form.gameDir)}>
              <FolderOpen size={15} />
            </button>
          </div>
        </div>
        <div className="row" style={{ gap: 14, marginBottom: 16 }}>
          <div className="field" style={{ flex: 1, marginBottom: 0 }}>
            <label>Window width</label>
            <input
              className="input"
              type="number"
              value={form.resolutionWidth}
              onChange={(e) => set('resolutionWidth', Number(e.target.value))}
            />
          </div>
          <div className="field" style={{ flex: 1, marginBottom: 0 }}>
            <label>Window height</label>
            <input
              className="input"
              type="number"
              value={form.resolutionHeight}
              onChange={(e) => set('resolutionHeight', Number(e.target.value))}
            />
          </div>
        </div>
        <div className="between">
          <div>
            <label style={{ fontWeight: 600, fontSize: 13 }}>Launch fullscreen</label>
            <div className="hint" style={{ marginTop: 2 }}>
              Start Minecraft in fullscreen instead of a window.
            </div>
          </div>
          <Toggle on={form.fullscreen} onClick={() => set('fullscreen', !form.fullscreen)} />
        </div>
      </Section>

      <Section icon={<Package size={18} />} title="CurseForge">
        <div className="field">
          <label>API key</label>
          <input
            className="input"
            type="password"
            placeholder="Paste your CurseForge API key"
            value={form.cfApiKey}
            onChange={(e) => set('cfApiKey', e.target.value.trim())}
          />
          <div className="hint">
            Get a free key at console.curseforge.com. Leave the proxy field below empty to use it.
          </div>
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label>Proxy server URL (optional)</label>
          <input
            className="input"
            placeholder="Leave empty to use the API key"
            value={form.cfProxyUrl}
            onChange={(e) => set('cfProxyUrl', e.target.value.trim())}
          />
          <div className="hint">
            {form.cfProxyUrl
              ? 'A proxy URL is set, so the API key above is ignored.'
              : 'Empty — modpack browsing uses the API key above.'}
          </div>
        </div>
      </Section>
    </div>
  )
}
