import { useEffect, useState } from 'react'
import {
  Check,
  Cpu,
  Download,
  FolderOpen,
  Globe,
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

export function Settings(): JSX.Element {
  const settings = useStore((s) => s.settings)
  const systemInfo = useStore((s) => s.systemInfo)
  const java = useStore((s) => s.java)
  const javaRuntimes = useStore((s) => s.javaRuntimes)
  const providers = useStore((s) => s.providers)
  const refreshJava = useStore((s) => s.refreshJava)
  const saveSettings = useStore((s) => s.saveSettings)
  const toast = useStore((s) => s.toast)

  const [form, setForm] = useState<SettingsType | null>(settings)
  const [checks, setChecks] = useState<NetworkCheck[] | null>(null)
  const [checking, setChecking] = useState(false)
  const [installingJava, setInstallingJava] = useState<number | null>(null)

  useEffect(() => setForm(settings), [settings])

  if (!form) return <div className="page" />
  const set = <K extends keyof SettingsType>(k: K, v: SettingsType[K]): void =>
    setForm({ ...form, [k]: v })

  async function saveAll(): Promise<void> {
    if (form) await saveSettings(form)
    toast('Settings saved', 'success')
  }

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

      <Section icon={<ShieldCheck size={18} />} title="How the game starts">
        <div className="style-picker">
          {(
            [
              [
                'direct',
                'Direct · Openforge launches it',
                'Runs the game itself using the account you selected. Microsoft accounts get full online play; offline profiles stay local.'
              ],
              [
                'official',
                'Hand off · Minecraft Launcher',
                'Registers the instance as an installation and opens the official launcher, which handles sign-in and starts the game.'
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
        <div className="hint" style={{ marginTop: 10 }}>
          Accounts are managed from the account button at the bottom of the sidebar.
        </div>
      </Section>

      <Section icon={<User size={18} />} title="Microsoft sign-in">
        <div className="field">
          <label>Azure application (client) ID</label>
          <input
            className="input"
            placeholder="00000000-0000-0000-0000-000000000000"
            value={form.msClientId}
            onChange={(e) => set('msClientId', e.target.value.trim())}
          />
          <div className="hint">
            Microsoft only grants Minecraft sign-in to a registered application, and Openforge ships
            no shared one — so signing in natively needs an app ID of your own. Create a free Azure
            app (personal Microsoft accounts, public client, device-code flow enabled) and paste its
            client ID here. Leave it empty to use the Minecraft Launcher hand-off above instead.
          </div>
          <button
            className="btn sm"
            style={{ marginTop: 10 }}
            onClick={() =>
              api.openExternal('https://learn.microsoft.com/en-us/minecraft/creator/documents/minecraftauthentication')
            }
          >
            <Globe size={14} /> How to register an app
          </button>
        </div>
      </Section>

      <Section icon={<Package size={18} />} title="Content providers">
        <div className="field">
          <label>Default source in Discover</label>
          <div className="style-picker">
            {(
              [
                ['modrinth', 'Modrinth', 'Open API, no key, no setup. Carries Homestead and most modern packs.'],
                ['curseforge', 'CurseForge', 'The largest catalogue, including All the Mods. Needs a key or a proxy.']
              ] as [Provider, string, string][]
            ).map(([id, title, detail]) => (
              <button
                key={id}
                className={`style-card${form.defaultProvider === id ? ' active' : ''}`}
                onClick={() => set('defaultProvider', id)}
                aria-pressed={form.defaultProvider === id}
              >
                <span className={`provider-tag ${id}`} aria-hidden="true">
                  {title}
                </span>
                <span>
                  <strong>{title}</strong>
                  <small>{detail}</small>
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <label>CurseForge API key</label>
          <input
            className="input"
            type="password"
            placeholder="Paste your CurseForge API key"
            value={form.cfApiKey}
            onChange={(e) => set('cfApiKey', e.target.value.trim())}
          />
          <div className="hint">
            Free at console.curseforge.com. A direct key also unlocks bulk resolution, which is the
            difference between a 400-mod pack installing in seconds and in minutes.
          </div>
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label>CurseForge proxy URL (optional)</label>
          <input
            className="input"
            placeholder="Leave empty to use the API key"
            value={form.cfProxyUrl}
            onChange={(e) => set('cfProxyUrl', e.target.value.trim())}
          />
          <div className="hint">
            {providers.curseforge.available
              ? `Connected in ${providers.curseforge.mode} mode.${
                  providers.curseforge.bulk ? ' Bulk resolution is available.' : ' Bulk resolution needs a direct key.'
                }`
              : 'Not configured — CurseForge browsing is unavailable. Modrinth still works.'}
          </div>
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
            onChange={(e) => set('ramMb', Number(e.target.value))}
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
            onChange={(e) => set('downloadConcurrency', Number(e.target.value))}
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
            onChange={(e) => set('jvmArgs', e.target.value)}
          />
          <div className="hint">Advanced. The defaults are tuned G1GC flags that work well for modded packs.</div>
        </div>
      </Section>

      <Section icon={<Globe size={18} />} title="Network">
        <div className="field">
          <label>Proxy URL (optional)</label>
          <input
            className="input"
            placeholder="Leave empty to use the system proxy"
            value={form.proxyUrl}
            onChange={(e) => set('proxyUrl', e.target.value.trim())}
          />
          <div className="hint">
            Openforge uses Chromium&apos;s network stack, so the system proxy and any certificates
            installed on this machine already apply. Set one here only to override that.
          </div>
        </div>
        <div className="field">
          <label>Certificates on managed networks</label>
          <div className="hint">
            Openforge verifies every HTTPS connection against this computer&apos;s certificate store
            and never disables that check. If your school or workplace inspects HTTPS traffic,
            install their root certificate into the Windows <em>Trusted Root Certification
            Authorities</em> store — Openforge, Chrome, and Edge all read from it, and the services
            below start working immediately. Nothing needs to be configured here.
          </div>
        </div>

        <div className="between" style={{ marginBottom: 12 }}>
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
                certificate this machine does not trust. That is a network policy, not a fault in the
                launcher — installing the organisation&apos;s root certificate above, or moving to a
                home network, restores these.
              </span>
            </div>
          </div>
        )}

        {checks && (
          <div className="panel runtime-list">
            {checks.map((check) => (
              <div className="runtime-row" key={check.url}>
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
              onChange={(e) => set('gameDir', e.target.value)}
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
            <span>Open Settings</span>
            <kbd>Ctrl</kbd>
            <kbd>3</kbd>
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
