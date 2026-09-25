import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ChevronRight,
  Cpu,
  Download,
  FolderOpen,
  HardDrive,
  Keyboard,
  Loader2,
  MemoryStick,
  Package,
  Palette,
  RefreshCw,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  User
} from 'lucide-react'
import type { ProviderStatus } from '@shared/ipc'
import { api } from '../api'
import { useStore } from '../store/store'
import type {
  LaunchMode,
  NetworkCheck,
  Provider,
  Settings as SettingsType,
  ThemeId,
  UiStyle
} from '@shared/types'
import { themeArt } from '../components/bits'
import { cleanError } from '../util'
import { SaveIndicator, type SaveState } from '../components/SaveIndicator'

/** Six forge worlds, each with its own generated key art and material palette. */
const THEMES: { id: ThemeId; name: string; latin: string }[] = [
  { id: 'terra', name: 'Overworld', latin: 'Verdant forge' },
  { id: 'infernum', name: 'Nether', latin: 'Ember forge' },
  { id: 'finis', name: 'The End', latin: 'Void forge' },
  { id: 'tenebrae', name: 'Deep Dark', latin: 'Deep forge' },
  { id: 'glacies', name: 'Snowy', latin: 'Frost forge' },
  { id: 'lux', name: 'Daylight', latin: 'Sunlit forge' }
]

function Section({
  icon,
  title,
  children
}: {
  icon: JSX.Element
  title: string
  children: React.ReactNode
}): JSX.Element {
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

function cfStatusText(cf: ProviderStatus['curseforge']): string {
  switch (cf.mode) {
    case 'builtin':
      return 'Using the built-in key. Bulk resolution is available, so large packs install fast.'
    case 'direct':
      return 'Using your own key. Bulk resolution is available.'
    case 'proxy':
      return 'Connected through your proxy. Bulk resolution needs a direct key.'
    default:
      return 'Not configured - CurseForge browsing is unavailable. Modrinth still works.'
  }
}


/** Typing and dragging settle for this long before they are written. */
const DEBOUNCE_MS = 400

/**
 * Every control saves as it changes: toggles, pickers, and selects at once;
 * text fields and sliders once they settle. There is no Save button.
 */
function useAutoSave(): {
  form: SettingsType | null
  change: (patch: Partial<SettingsType>, when?: 'now' | 'settle') => void
  flush: () => void
  state: SaveState
} {
  const settings = useStore((s) => s.settings)
  const saveSettings = useStore((s) => s.saveSettings)
  const toast = useStore((s) => s.toast)
  const [form, setForm] = useState<SettingsType | null>(settings)
  const [state, setState] = useState<SaveState>('idle')
  const pending = useRef<Partial<SettingsType>>({})
  const timer = useRef<number | undefined>(undefined)
  const fade = useRef<number | undefined>(undefined)

  // Adopt the saved (normalized) values, but never over something still being typed.
  useEffect(() => {
    if (Object.keys(pending.current).length === 0) setForm(settings)
  }, [settings])

  const flush = useCallback((): void => {
    window.clearTimeout(timer.current)
    const patch = pending.current
    pending.current = {}
    if (Object.keys(patch).length === 0) return
    setState('saving')
    saveSettings(patch).then(
      () => {
        setState('saved')
        window.clearTimeout(fade.current)
        fade.current = window.setTimeout(() => setState('idle'), 2200)
      },
      (e) => {
        setState('error')
        toast(cleanError(e), 'error')
      }
    )
  }, [saveSettings, toast])

  const change = useCallback(
    (patch: Partial<SettingsType>, when: 'now' | 'settle' = 'now'): void => {
      setForm((current) => (current ? { ...current, ...patch } : current))
      pending.current = { ...pending.current, ...patch }
      window.clearTimeout(timer.current)
      if (when === 'now') flush()
      else timer.current = window.setTimeout(flush, DEBOUNCE_MS)
    },
    [flush]
  )

  // Leaving the page must not drop a change that was still settling.
  const flushRef = useRef(flush)
  flushRef.current = flush
  useEffect(
    () => () => {
      flushRef.current()
      window.clearTimeout(fade.current)
    },
    []
  )

  return { form, change, flush, state }
}

export function Settings(): JSX.Element {
  const systemInfo = useStore((s) => s.systemInfo)
  const java = useStore((s) => s.java)
  const javaRuntimes = useStore((s) => s.javaRuntimes)
  const providers = useStore((s) => s.providers)
  const refreshJava = useStore((s) => s.refreshJava)
  const toast = useStore((s) => s.toast)
  const settingsAnchor = useStore((s) => s.settingsAnchor)
  const clearSettingsAnchor = useStore((s) => s.clearSettingsAnchor)
  const playStatus = useStore((s) => s.playStatus)
  const openOfficialLauncher = useStore((s) => s.openOfficialLauncher)

  const { form, change, flush, state } = useAutoSave()
  const [checks, setChecks] = useState<NetworkCheck[] | null>(null)
  const [checking, setChecking] = useState(false)
  const [installingJava, setInstallingJava] = useState<number | null>(null)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const advancedRef = useRef<HTMLDivElement>(null)

  // A "Connection check" fix button lands here with Advanced open.
  useEffect(() => {
    if (settingsAnchor !== 'advanced') return
    setAdvancedOpen(true)
    clearSettingsAnchor()
    window.setTimeout(() => advancedRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50)
  }, [settingsAnchor, clearSettingsAnchor])

  if (!form) return <div className="page" />
  /** Toggles, pickers and selects: saved at once. */
  const set = <K extends keyof SettingsType>(k: K, v: SettingsType[K]): void =>
    change({ [k]: v } as Partial<SettingsType>)
  /** Text fields and sliders: saved once they settle. */
  const type = <K extends keyof SettingsType>(k: K, v: SettingsType[K]): void =>
    change({ [k]: v } as Partial<SettingsType>, 'settle')

  async function runNetworkCheck(): Promise<void> {
    setChecking(true)
    try {
      setChecks(await api.networkCheck())
    } catch (e) {
      toast(cleanError(e), 'error')
    } finally {
      setChecking(false)
    }
  }

  const blocked = checks?.filter((check) => !check.ok) ?? []
  const intercepted = blocked.filter((check) => check.tlsIntercepted)
  const cf = providers.curseforge

  return (
    <div className="page settings-page">
      <div className="page-head">
        <div>
          <div className="eyebrow">Preferences</div>
          <h1 className="page-title">Settings</h1>
        </div>
        <SaveIndicator state={state} />
      </div>

      <Section icon={<ShieldCheck size={18} />} title="How the game starts">
        <div className="style-picker">
          {(
            [
              [
                'direct',
                'Offline - Openforge starts it',
                'Fast, with your offline profile. Needs an account that owns Minecraft signed in to the official launcher on this PC. Single-player, LAN and offline-mode servers.'
              ],
              [
                'official',
                'Minecraft Launcher - hand off',
                'Openforge prepares the instance and opens the official launcher, which signs you in with Microsoft. Online servers and Realms.'
              ]
            ] as [LaunchMode, string, string][]
          ).map(([id, title, detail]) => (
            <button
              key={id}
              className={`style-card${form.launchMode === id ? ' active' : ''}`}
              onClick={() => set('launchMode', id)}
              aria-pressed={form.launchMode === id}
            >
              <span className={`launch-mode-icon ${id}`} aria-hidden="true">
                {id === 'official' ? <ShieldCheck size={24} /> : <User size={24} />}
              </span>
              <span>
                <strong>{title}</strong>
                <small>{detail}</small>
              </span>
            </button>
          ))}
        </div>
        {playStatus && (
          <div className={`hint play-status-hint${playStatus.offline.allowed ? '' : ' warn'}`} style={{ marginTop: 10 }}>
            {playStatus.offline.allowed ? 'Offline play is available: ' : 'Offline play is locked: '}
            {playStatus.offline.reason}{' '}
            {!playStatus.offline.allowed && (
              <button className="link-button" onClick={() => openOfficialLauncher()}>
                Open Minecraft Launcher
              </button>
            )}
          </div>
        )}
        <div className="hint" style={{ marginTop: 6 }}>
          Your offline name is set from the profile button at the bottom of the sidebar.
        </div>
      </Section>

      <Section icon={<Package size={18} />} title="Content providers">
        <div className="field">
          <label htmlFor="default-source">Discover opens on</label>
          <select
            id="default-source"
            className="select"
            value={form.defaultProvider}
            onChange={(e) => set('defaultProvider', e.target.value as Provider)}
          >
            <option value="curseforge">
              CurseForge{cf.available ? '' : ' (unavailable - Modrinth is used meanwhile)'}
            </option>
            <option value="modrinth">Modrinth</option>
          </select>
          <div className="hint">{cfStatusText(cf)} Discover remembers the source you pick last.</div>
        </div>

        <div className={`advanced${advancedOpen ? ' open' : ''}`} ref={advancedRef}>
          <button
            className="advanced-toggle"
            aria-expanded={advancedOpen}
            onClick={() => setAdvancedOpen((open) => !open)}
          >
            <ChevronRight size={15} className="advanced-chevron" />
            <span>
              <strong>Advanced</strong>
              <small>Your own CurseForge key, a CurseForge proxy, a network proxy, and a connection check</small>
            </span>
          </button>

          {advancedOpen && (
            <div className="advanced-body">
              <div className="field">
                <label htmlFor="cf-key">Your own CurseForge API key</label>
                <input
                  id="cf-key"
                  className="input"
                  type="password"
                  autoComplete="off"
                  placeholder={
                    cf.mode === 'builtin'
                      ? 'Optional - the built-in key is in use'
                      : 'Paste a key from console.curseforge.com'
                  }
                  value={form.cfApiKey}
                  onChange={(e) => type('cfApiKey', e.target.value.trim())}
                  onBlur={flush}
                />
                <div className="hint">Overrides the built-in key. Free at console.curseforge.com.</div>
              </div>
              <div className="field">
                <label htmlFor="cf-proxy">CurseForge proxy URL</label>
                <input
                  id="cf-proxy"
                  className="input"
                  placeholder="https://your-server.example"
                  value={form.cfProxyUrl}
                  onChange={(e) => type('cfProxyUrl', e.target.value.trim())}
                  onBlur={flush}
                />
                <div className="hint">
                  A server that holds the key for you. It wins over any key when set; bulk resolution needs a
                  direct key.
                </div>
              </div>
              <div className="field">
                <label htmlFor="net-proxy">Network proxy</label>
                <input
                  id="net-proxy"
                  className="input"
                  placeholder="Empty uses the system proxy"
                  value={form.proxyUrl}
                  onChange={(e) => type('proxyUrl', e.target.value.trim())}
                  onBlur={flush}
                />
                <div className="hint">
                  Only to override the system proxy. Certificates come from this computer&apos;s trusted-root
                  store; if a school or work network inspects HTTPS, install its root certificate in Windows.
                </div>
              </div>

              <div className="between" style={{ marginBottom: 10 }}>
                <label style={{ fontWeight: 600, fontSize: 13, margin: 0 }}>Connection check</label>
                <button className="btn sm" onClick={runNetworkCheck} disabled={checking}>
                  {checking ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />} Run check
                </button>
              </div>

              {intercepted.length > 0 && (
                <div className="notice danger">
                  <TriangleAlert size={16} />
                  <div>
                    <strong>This network is intercepting HTTPS</strong>
                    <span>
                      {intercepted.length} service{intercepted.length === 1 ? '' : 's'} answered with a
                      certificate this machine does not trust. Install the organisation&apos;s root certificate
                      into Windows, or use another network.
                    </span>
                  </div>
                </div>
              )}

              {checks && (
                <div className="panel runtime-list">
                  {checks.map((check) => (
                    <div className="runtime-row" key={check.name}>
                      <div>
                        <strong>{check.name}</strong>
                        <small>{check.ok ? check.url : (check.error ?? 'Unreachable')}</small>
                      </div>
                      <span className={`chip ${check.ok ? 'accent' : 'warn'}`}>
                        {check.ok ? `OK ${check.status ?? ''}` : check.tlsIntercepted ? 'Blocked' : 'Failed'}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </Section>

      <Section icon={<Cpu size={18} />} title="Java runtime">
        <div className="between setting-toggle-row" style={{ marginTop: 0 }}>
          <div>
            <label style={{ fontWeight: 600, fontSize: 13 }}>Manage Java automatically</label>
            <div className="hint" style={{ marginTop: 2 }}>
              Download the exact Eclipse Temurin runtime each Minecraft version asks for. Leave this
              on unless you want to manage JDKs yourself.
            </div>
          </div>
          <Toggle on={form.autoJava} onClick={() => set('autoJava', !form.autoJava)} />
        </div>

        <div className="field" style={{ marginTop: 16 }}>
          <label>Managed runtimes</label>
          <div className="panel runtime-list">
            {javaRuntimes.map((runtime) => (
              <div className="runtime-row" key={runtime.majorVersion}>
                <div>
                  <strong>Java {runtime.majorVersion}</strong>
                  <small>{runtime.usedFor}</small>
                </div>
                {runtime.installed ? (
                  <div className="row" style={{ gap: 8 }}>
                    <span className="chip accent">Installed</span>
                    <button
                      className="win-btn"
                      title="Remove this runtime"
                      onClick={async () => {
                        await api.removeJavaRuntime(runtime.majorVersion)
                        await refreshJava()
                      }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ) : (
                  <button
                    className="btn sm"
                    disabled={installingJava !== null}
                    onClick={async () => {
                      setInstallingJava(runtime.majorVersion)
                      try {
                        await api.installJavaRuntime(runtime.majorVersion)
                        await refreshJava()
                        toast(`Java ${runtime.majorVersion} installed`, 'success')
                      } catch (e) {
                        toast(cleanError(e), 'error')
                      } finally {
                        setInstallingJava(null)
                      }
                    }}
                  >
                    {installingJava === runtime.majorVersion ? (
                      <Loader2 size={14} className="spin" />
                    ) : (
                      <Download size={14} />
                    )}
                    Install
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="field" style={{ marginBottom: 0 }}>
          <label>Java executable override</label>
          <div className="input-row">
            <select
              className="select"
              value={form.javaPath}
              onChange={(e) => set('javaPath', e.target.value)}
              style={{ flex: 1 }}
            >
              <option value="">Pick the right runtime automatically</option>
              {java.map((j) => (
                <option key={j.path} value={j.path}>
                  Java {j.majorVersion} ({j.version}){j.managed ? ' — managed' : ''} — {j.path}
                </option>
              ))}
            </select>
            <button className="btn icon" title="Rescan" onClick={refreshJava}>
              <RefreshCw size={15} />
            </button>
          </div>
          <div className="hint">
            {java.length
              ? `Found ${java.length} runtime${java.length === 1 ? '' : 's'}: Java ${java
                  .map((j) => j.majorVersion)
                  .join(', ')}.`
              : 'No Java on this machine yet — with automatic management on, Openforge fetches one when you first play.'}
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
            max={systemInfo?.maxRamMb ?? 4096}
            step={256}
            value={form.ramMb}
            onChange={(e) => type('ramMb', Number(e.target.value))}
            onPointerUp={flush}
            onKeyUp={flush}
          />
          <div className="between hint" style={{ marginTop: 6 }}>
            <span>1 GB</span>
            <span>{((systemInfo?.maxRamMb ?? 4096) / 1024).toFixed(1)} GB safe maximum</span>
          </div>
          {systemInfo && (
            <div className="hint" style={{ marginTop: 8 }}>
              This computer has {(systemInfo.totalMemoryMb / 1024).toFixed(1)} GB installed
              ({systemInfo.platform}/{systemInfo.arch}). Openforge reserves enough for the OS and
              background apps.
            </div>
          )}
        </div>
        <div className="field">
          <div className="between" style={{ marginBottom: 8 }}>
            <label style={{ margin: 0 }}>Parallel downloads</label>
            <span className="chip accent">{form.downloadConcurrency}</span>
          </div>
          <input
            className="slider"
            type="range"
            min={1}
            max={64}
            step={1}
            value={form.downloadConcurrency}
            onChange={(e) => type('downloadConcurrency', Number(e.target.value))}
            onPointerUp={flush}
            onKeyUp={flush}
          />
          <div className="hint" style={{ marginTop: 6 }}>
            How many files to fetch at once. 16 suits most connections; lower it if your network or a
            provider starts refusing requests.
          </div>
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label>JVM arguments</label>
          <textarea
            className="input"
            rows={3}
            value={form.jvmArgs}
            onChange={(e) => type('jvmArgs', e.target.value)}
            onBlur={flush}
          />
          <div className="hint">Advanced. The defaults are tuned G1GC flags that work well for modded packs.</div>
        </div>
      </Section>

      <Section icon={<Palette size={18} />} title="Appearance">
        <div className="field">
          <label>Interface style</label>
          <div className="style-picker">
            {(
              [
                ['modern', 'Modern', 'Softer cards, calmer shadows, and roomier controls'],
                ['classic', 'Classic', 'Square inventory panels and strong pixel bevels']
              ] as [UiStyle, string, string][]
            ).map(([id, title, detail]) => (
              <button
                key={id}
                className={`style-card${form.uiStyle === id ? ' active' : ''}`}
                onClick={() => set('uiStyle', id)}
                aria-pressed={form.uiStyle === id}
              >
                <span className={`style-preview ${id}`} aria-hidden="true">
                  <i />
                  <i />
                  <i />
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
                <span className="theme-swatch">
                  <img src={themeArt[t.id]} alt="" />
                </span>
                <span className="theme-name">{t.name}</span>
                <span className="theme-latin">{t.latin}</span>
              </button>
            ))}
          </div>
          <div className="hint">Each theme changes the materials, accent, and generated forge landscape.</div>
        </div>
      </Section>

      <Section icon={<HardDrive size={18} />} title="Game & window">
        <div className="field">
          <label>Game directory</label>
          <div className="input-row">
            <input
              className="input"
              value={form.gameDir}
              onChange={(e) => type('gameDir', e.target.value)}
              onBlur={flush}
              style={{ flex: 1 }}
            />
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
          <div className="hint">
            Instances, shared libraries, assets, and managed Java runtimes all live here.
          </div>
        </div>
        <div className="row" style={{ gap: 14, marginBottom: 16 }}>
          <div className="field" style={{ flex: 1, marginBottom: 0 }}>
            <label>Window width</label>
            <input
              className="input"
              type="number"
              min={320}
              value={form.resolutionWidth}
              onChange={(e) => e.target.value && type('resolutionWidth', Number(e.target.value))}
              onBlur={flush}
            />
          </div>
          <div className="field" style={{ flex: 1, marginBottom: 0 }}>
            <label>Window height</label>
            <input
              className="input"
              type="number"
              min={240}
              value={form.resolutionHeight}
              onChange={(e) => e.target.value && type('resolutionHeight', Number(e.target.value))}
              onBlur={flush}
            />
          </div>
        </div>
        <div className="between setting-toggle-row">
          <div>
            <label style={{ fontWeight: 600, fontSize: 13 }}>Launch fullscreen</label>
            <div className="hint" style={{ marginTop: 2 }}>
              Start Minecraft in fullscreen instead of a window.
            </div>
          </div>
          <Toggle on={form.fullscreen} onClick={() => set('fullscreen', !form.fullscreen)} />
        </div>
        <div className="between setting-toggle-row">
          <div>
            <label style={{ fontWeight: 600, fontSize: 13 }}>Hide launcher while playing</label>
            <div className="hint" style={{ marginTop: 2 }}>
              Hide Openforge when Minecraft starts, then bring it back when the game closes.
            </div>
          </div>
          <Toggle
            on={form.closeLauncherOnLaunch}
            onClick={() => set('closeLauncherOnLaunch', !form.closeLauncherOnLaunch)}
          />
        </div>
      </Section>

      <Section icon={<Keyboard size={18} />} title="Keyboard shortcuts">
        <div className="shortcut-grid">
          <div>
            <span>Open Library</span>
            <kbd>Ctrl</kbd>
            <kbd>1</kbd>
          </div>
          <div>
            <span>Open Discover</span>
            <kbd>Ctrl</kbd>
            <kbd>2</kbd>
          </div>
          <div>
            <span>Open Servers</span>
            <kbd>Ctrl</kbd>
            <kbd>3</kbd>
          </div>
          <div>
            <span>Open Settings</span>
            <kbd>Ctrl</kbd>
            <kbd>4</kbd>
          </div>
          <div>
            <span>New instance</span>
            <kbd>Ctrl</kbd>
            <kbd>N</kbd>
          </div>
          <div>
            <span>Search content</span>
            <kbd>Ctrl</kbd>
            <kbd>K</kbd>
          </div>
          <div>
            <span>Close overlay</span>
            <kbd>Esc</kbd>
          </div>
        </div>
      </Section>
    </div>
  )
}
