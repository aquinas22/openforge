import { useCallback, useEffect, useState } from 'react'
import {
  ArrowUpCircle,
  Blocks,
  Boxes,
  CircleStop,
  Clock,
  Copy,
  Download,
  ExternalLink,
  FolderOpen,
  Globe,
  Image,
  Loader2,
  MemoryStick,
  Package,
  PackageCheck,
  Play,
  Plus,
  Power,
  RefreshCw,
  Save,
  Share2,
  Sparkles,
  Terminal,
  Trash2,
  TriangleAlert,
  X
} from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { api } from '../api'
import { useStore } from '../store/store'
import { bytes, cleanError, loaderLabel, playtime, timeAgo } from '../util'
import type { ContentKind, InstalledMod, WorldSummary } from '@shared/types'

type Tab = 'overview' | 'content' | 'worlds' | 'manage'

const CONTENT_TABS: { key: ContentKind; label: string; icon: JSX.Element; empty: string }[] = [
  { key: 'mod', label: 'Mods', icon: <Blocks size={14} />, empty: 'No mods in this instance yet.' },
  {
    key: 'resourcepack',
    label: 'Texture packs',
    icon: <Image size={14} />,
    empty: 'No texture packs yet. Find some in Discover.'
  },
  {
    key: 'shader',
    label: 'Shaders',
    icon: <Sparkles size={14} />,
    empty: 'No shader packs yet. You will also need Iris or OptiFine installed.'
  },
  { key: 'datapack', label: 'Data packs', icon: <Boxes size={14} />, empty: 'No data packs yet.' }
]

export function InstanceDetail(): JSX.Element | null {
  const id = useStore((s) => s.detailInstance)
  const inst = useStore((s) => s.instances.find((i) => i.id === id))
  const st = useStore(
    useShallow((s) => ({
      busy: id ? !!s.busy[id] : false,
      running: id ? !!s.running[id] : false,
      label: id ? s.progress[id]?.label : undefined
    }))
  )
  const settings = useStore((s) => s.settings)
  const systemInfo = useStore((s) => s.systemInfo)
  const openDetail = useStore((s) => s.openDetail)
  const openConsole = useStore((s) => s.openConsole)
  const launch = useStore((s) => s.launch)
  const kill = useStore((s) => s.kill)
  const repair = useStore((s) => s.repair)
  const deleteInstance = useStore((s) => s.deleteInstance)
  const duplicateInstance = useStore((s) => s.duplicateInstance)
  const updatePack = useStore((s) => s.updatePack)
  const refreshInstances = useStore((s) => s.refreshInstances)
  const toast = useStore((s) => s.toast)

  const [tab, setTab] = useState<Tab>('overview')
  const [contentKind, setContentKind] = useState<ContentKind>('mod')
  const [items, setItems] = useState<InstalledMod[]>([])
  const [itemsLoading, setItemsLoading] = useState(false)
  const [worlds, setWorlds] = useState<WorldSummary[]>([])
  const [checking, setChecking] = useState(false)
  const [serverAddress, setServerAddress] = useState('')

  const loadContent = useCallback(
    async (kind: ContentKind) => {
      if (!id) return
      setItemsLoading(true)
      try {
        setItems(await api.listContent(id, kind))
      } catch {
        setItems([])
      } finally {
        setItemsLoading(false)
      }
    },
    [id]
  )

  useEffect(() => {
    if (id) loadContent(contentKind)
  }, [id, contentKind, loadContent])

  useEffect(() => {
    if (id && tab === 'worlds') api.listWorlds(id).then(setWorlds).catch(() => setWorlds([]))
  }, [id, tab])

  // Ask the provider whether the pack itself has a newer release.
  useEffect(() => {
    if (!id || !inst?.provider) return
    api.checkPackUpdate(id).then(() => refreshInstances()).catch(() => undefined)
  }, [id, inst?.provider, refreshInstances])

  if (!id || !inst) return null
  const currentTab = CONTENT_TABS.find((t) => t.key === contentKind)!
  const updatable = items.filter((item) => item.updateAvailable).length

  return (
    <>
      <div className="scrim" onClick={() => openDetail(null)} style={{ background: 'rgba(4,5,10,0.5)' }} />
      <aside className="drawer">
        <div className="drawer-hero">
          {inst.iconUrl ? <img src={inst.iconUrl} alt="" /> : <div className="drawer-hero-blank" />}
          <div className="drawer-hero-wash" />
          <button className="win-btn drawer-close" onClick={() => openDetail(null)} aria-label="Close">
            <X size={18} />
          </button>
          <h2 className="drawer-hero-title">{inst.name}</h2>
        </div>

        <div className="drawer-tabs" role="tablist" aria-label="Instance sections">
          {(
            [
              ['overview', 'Overview'],
              ['content', 'Content'],
              ['worlds', 'Worlds'],
              ['manage', 'Manage']
            ] as [Tab, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              role="tab"
              aria-selected={tab === key}
              className={tab === key ? 'active' : ''}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="drawer-body drawer-body-padded">
          {tab === 'overview' && (
            <>
              <div className="row" style={{ gap: 8, marginBottom: 18, flexWrap: 'wrap' }}>
                <span className="chip accent">
                  <Boxes size={13} /> {loaderLabel(inst.loader)}
                  {inst.loaderVersion ? ` · ${inst.loaderVersion}` : ''}
                </span>
                <span className="chip">{inst.mcVersion}</span>
                {inst.provider && (
                  <span className={`provider-tag ${inst.provider}`}>
                    {inst.provider === 'modrinth' ? 'Modrinth' : 'CurseForge'}
                  </span>
                )}
                {inst.packVersion && <span className="chip">v{inst.packVersion}</span>}
                {st.running && <span className="chip accent">Running</span>}
              </div>

              {inst.updateAvailable && (
                <div className="notice accent">
                  <ArrowUpCircle size={16} />
                  <div>
                    <strong>Update available — {inst.updateAvailable.versionNumber}</strong>
                    <span>
                      Openforge replaces the pack&apos;s mods and configs and removes files the old
                      release shipped. Your worlds, screenshots, and backups are never touched.
                    </span>
                  </div>
                  <button
                    className="btn sm primary"
                    disabled={st.busy || st.running}
                    onClick={() => updatePack(inst.id)}
                  >
                    Update
                  </button>
                </div>
              )}

              {inst.note && (
                <div className="notice warn">
                  <TriangleAlert size={16} />
                  <div>
                    <strong>Some files need you</strong>
                    <span>{inst.note}</span>
                  </div>
                </div>
              )}

              {inst.manualDownloads && inst.manualDownloads.length > 0 && (
                <div className="panel manual-list">
                  <div className="eyebrow" style={{ padding: '12px 14px 6px' }}>
                    Download these by hand, then drop them into the mods folder
                  </div>
                  {inst.manualDownloads.slice(0, 25).map((entry) => (
                    <div className="manual-row" key={entry.pageUrl + entry.name}>
                      <span>{entry.name}</span>
                      <button className="btn sm ghost" onClick={() => api.openExternal(entry.pageUrl)}>
                        Open <ExternalLink size={13} />
                      </button>
                    </div>
                  ))}
                  <div className="manual-row">
                    <button className="btn sm" onClick={() => api.openInstanceFolder(inst.id)}>
                      <FolderOpen size={14} /> Open mods folder
                    </button>
                  </div>
                </div>
              )}

              <div className="row" style={{ gap: 12, margin: '20px 0 22px' }}>
                {st.running ? (
                  <button className="btn-play" onClick={() => kill(inst.id)}>
                    <CircleStop size={22} /> Stop
                  </button>
                ) : st.busy ? (
                  <button className="btn-play" disabled>
                    <Loader2 size={22} className="spin" /> {st.label ?? 'Working…'}
                  </button>
                ) : (
                  <button className="btn-play" onClick={() => launch(inst.id)}>
                    {inst.installed ? <Play size={22} fill="currentColor" /> : <Download size={22} />}
                    {inst.installed ? 'Play' : 'Install & Play'}
                  </button>
                )}
                <button className="btn icon" title="Console" onClick={() => openConsole(inst.id)}>
                  <Terminal size={16} />
                </button>
              </div>

              <div className="eyebrow" style={{ marginBottom: 10 }}>
                Join a server directly
              </div>
              <div className="input-row" style={{ marginBottom: 22 }}>
                <input
                  className="input"
                  placeholder="play.example.net"
                  value={serverAddress}
                  onChange={(e) => setServerAddress(e.target.value)}
                />
                <button
                  className="btn"
                  disabled={!serverAddress.trim() || st.busy || st.running}
                  onClick={() => launch(inst.id, { type: 'multiplayer', id: serverAddress.trim() })}
                >
                  <Globe size={15} /> Play on server
                </button>
              </div>

              <div className="panel" style={{ padding: 4, marginBottom: 20 }}>
                <Stat icon={<Clock size={15} />} label="Last played" value={timeAgo(inst.lastPlayed)} />
                <Stat icon={<Play size={15} />} label="Total playtime" value={playtime(inst.totalPlaySeconds)} />
                <Stat icon={<Boxes size={15} />} label="Created" value={timeAgo(inst.createdAt)} last />
              </div>

              <div className="eyebrow" style={{ marginBottom: 10 }}>
                Memory
              </div>
              <div className="panel" style={{ padding: 16 }}>
                <div className="between" style={{ marginBottom: 10 }}>
                  <span className="row" style={{ gap: 8 }}>
                    <MemoryStick size={15} /> Instance allocation
                  </span>
                  <span className="chip accent">
                    {((inst.ramMb ?? settings?.ramMb ?? 4096) / 1024).toFixed(1)} GB
                  </span>
                </div>
                <input
                  className="slider"
                  type="range"
                  min={1024}
                  max={systemInfo?.maxRamMb ?? 4096}
                  step={256}
                  value={inst.ramMb ?? settings?.ramMb ?? 4096}
                  disabled={st.running}
                  onChange={async (e) => {
                    await api.updateInstance(inst.id, { ramMb: Number(e.target.value) })
                    await refreshInstances()
                  }}
                />
                <div className="between hint" style={{ marginTop: 5 }}>
                  <span>1 GB</span>
                  <span>{((systemInfo?.maxRamMb ?? 4096) / 1024).toFixed(1)} GB safe maximum</span>
                </div>
                <p className="hint" style={{ marginTop: 10 }}>
                  Large packs want 6–10 GB. More is not always better — the garbage collector has to
                  walk everything you give it.
                </p>
              </div>
            </>
          )}

          {tab === 'content' && (
            <>
              <div className="pill-tabs" role="tablist" aria-label="Content kind">
                {CONTENT_TABS.map((entry) => (
                  <button
                    key={entry.key}
                    role="tab"
                    aria-selected={contentKind === entry.key}
                    className={contentKind === entry.key ? 'active' : ''}
                    onClick={() => setContentKind(entry.key)}
                  >
                    {entry.icon} {entry.label}
                  </button>
                ))}
              </div>

              <div className="between" style={{ margin: '16px 0 12px' }}>
                <div className="eyebrow" style={{ margin: 0 }}>
                  {currentTab.label} · {items.length}
                  {updatable > 0 && <span className="chip accent tiny"> {updatable} update</span>}
                </div>
                <div className="row" style={{ gap: 8 }}>
                  <button
                    className="btn sm"
                    disabled={st.running || checking}
                    onClick={async () => {
                      setChecking(true)
                      try {
                        setItems(await api.checkContentUpdates(inst.id, contentKind))
                        toast('Checked for updates', 'success')
                      } catch (e) {
                        toast(cleanError(e), 'error')
                      } finally {
                        setChecking(false)
                      }
                    }}
                  >
                    {checking ? <Loader2 size={14} className="spin" /> : <PackageCheck size={14} />} Check
                  </button>
                  <button
                    className="btn sm primary"
                    disabled={st.running}
                    onClick={async () => {
                      setItems(await api.importContent(inst.id, contentKind))
                      toast('Files imported', 'success')
                    }}
                  >
                    <Plus size={14} /> Add file
                  </button>
                </div>
              </div>

              {updatable > 0 && (
                <button
                  className="btn primary"
                  style={{ width: '100%', marginBottom: 12 }}
                  disabled={st.running || itemsLoading}
                  onClick={async () => {
                    setItemsLoading(true)
                    try {
                      const result = await api.updateContent(inst.id, contentKind)
                      setItems(result.mods)
                      toast(
                        result.installed.length
                          ? `Updated ${result.installed.length} items`
                          : 'Everything is already current',
                        'success'
                      )
                      if (result.failed?.length) toast(result.failed.join('; '), 'error')
                    } catch (e) {
                      toast(cleanError(e), 'error')
                    } finally {
                      setItemsLoading(false)
                    }
                  }}
                >
                  <ArrowUpCircle size={15} /> Update {updatable} {currentTab.label.toLowerCase()}
                </button>
              )}

              <div className="panel mod-list">
                {itemsLoading ? (
                  <div className="empty" style={{ padding: 24 }}>
                    <Loader2 size={18} className="spin" /> Reading files…
                  </div>
                ) : items.length === 0 ? (
                  <div className="empty" style={{ padding: 24 }}>
                    {currentTab.empty}
                  </div>
                ) : (
                  items.map((item) => (
                    <div className={`mod-row${item.enabled ? '' : ' disabled'}`} key={item.fileName}>
                      <button
                        className={`mod-power${item.enabled ? ' on' : ''}`}
                        title={item.enabled ? 'Disable' : 'Enable'}
                        disabled={st.running}
                        onClick={async () =>
                          setItems(
                            await api.toggleContent(inst.id, contentKind, item.fileName, !item.enabled)
                          )
                        }
                      >
                        <Power size={15} />
                      </button>
                      <div className="mod-info">
                        <strong>{item.displayName}</strong>
                        <small>
                          {bytes(item.size)} · {item.enabled ? 'Enabled' : 'Disabled'}
                          {item.version ? ` · ${item.version}` : ''}
                          {item.provider ? ` · ${item.provider}` : ''}
                        </small>
                      </div>
                      {item.updateAvailable && (
                        <span className="chip accent tiny" title={`Update to ${item.updateAvailable.versionNumber}`}>
                          <ArrowUpCircle size={11} /> New
                        </span>
                      )}
                      <button
                        className="win-btn"
                        title="Remove"
                        disabled={st.running}
                        onClick={async () => {
                          if (confirm(`Remove ${item.displayName} from this instance?`)) {
                            setItems(await api.deleteContent(inst.id, contentKind, item.fileName))
                          }
                        }}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))
                )}
              </div>
            </>
          )}

          {tab === 'worlds' && (
            <>
              <div className="eyebrow" style={{ marginBottom: 10 }}>
                Saved worlds · {worlds.length}
              </div>
              <div className="panel mod-list">
                {worlds.length === 0 ? (
                  <div className="empty" style={{ padding: 24 }}>
                    No worlds yet. Start the game and create one.
                  </div>
                ) : (
                  worlds.map((world) => (
                    <div className="mod-row" key={world.folderName}>
                      <div className="mod-info">
                        <strong>{world.name}</strong>
                        <small>
                          {world.sizeMb} MB
                          {world.lastPlayed ? ` · played ${timeAgo(new Date(world.lastPlayed).toISOString())}` : ''}
                        </small>
                      </div>
                      <button
                        className="btn sm ghost"
                        disabled={st.running}
                        title="Play this world"
                        onClick={() => launch(inst.id, { type: 'singleplayer', id: world.folderName })}
                      >
                        <Play size={13} /> Play
                      </button>
                      <button
                        className="btn sm"
                        title="Zip this world into the instance's backups folder"
                        onClick={async () => {
                          try {
                            const path = await api.backupWorld(inst.id, world.folderName)
                            toast(path ? 'World backed up' : 'Backup cancelled', 'success')
                          } catch (e) {
                            toast(cleanError(e), 'error')
                          }
                        }}
                      >
                        <Save size={13} /> Back up
                      </button>
                    </div>
                  ))
                )}
              </div>
            </>
          )}

          {tab === 'manage' && (
            <div style={{ display: 'grid', gap: 8 }}>
              <button
                className="btn"
                style={{ justifyContent: 'flex-start' }}
                onClick={() => api.openInstanceFolder(inst.id)}
              >
                <FolderOpen size={16} /> Open instance folder
              </button>
              <button
                className="btn"
                style={{ justifyContent: 'flex-start' }}
                disabled={st.busy || st.running}
                onClick={() => repair(inst.id)}
              >
                <RefreshCw size={16} /> Verify and repair files
              </button>
              <button
                className="btn"
                style={{ justifyContent: 'flex-start' }}
                disabled={st.busy || st.running}
                onClick={() => duplicateInstance(inst.id)}
              >
                <Copy size={16} /> Duplicate instance
              </button>
              <button
                className="btn"
                style={{ justifyContent: 'flex-start' }}
                disabled={st.running}
                onClick={async () => {
                  try {
                    const path = await api.exportPack(inst.id, 'mrpack')
                    if (path) toast('Exported as a Modrinth pack', 'success')
                  } catch (e) {
                    toast(cleanError(e), 'error')
                  }
                }}
              >
                <Share2 size={16} /> Export as .mrpack
              </button>
              <button
                className="btn"
                style={{ justifyContent: 'flex-start' }}
                disabled={st.running}
                onClick={async () => {
                  try {
                    const path = await api.exportPack(inst.id, 'curseforge')
                    if (path) toast('Exported as a CurseForge pack', 'success')
                  } catch (e) {
                    toast(cleanError(e), 'error')
                  }
                }}
              >
                <Package size={16} /> Export as CurseForge zip
              </button>

              <div className="eyebrow" style={{ margin: '14px 0 4px' }}>
                Advanced
              </div>
              <label className="field">
                <span>Extra JVM flags for this instance</span>
                <input
                  className="input"
                  defaultValue={inst.jvmArgs ?? ''}
                  placeholder="-Dsomething=true"
                  onBlur={async (e) => {
                    await api.updateInstance(inst.id, { jvmArgs: e.target.value })
                    await refreshInstances()
                  }}
                />
              </label>
              <label className="field">
                <span>Java override (leave empty to use the managed runtime)</span>
                <input
                  className="input"
                  defaultValue={inst.javaPath ?? ''}
                  placeholder="C:\\Program Files\\Eclipse Adoptium\\jdk-21\\bin\\java.exe"
                  onBlur={async (e) => {
                    await api.updateInstance(inst.id, { javaPath: e.target.value })
                    await refreshInstances()
                  }}
                />
              </label>

              <button
                className="btn danger"
                style={{ justifyContent: 'flex-start', marginTop: 10 }}
                disabled={st.running}
                onClick={() => {
                  if (confirm(`Delete "${inst.name}"? This removes its mods, worlds, and saves.`)) {
                    deleteInstance(inst.id)
                  }
                }}
              >
                <Trash2 size={16} /> Delete instance
              </button>
            </div>
          )}
          <div style={{ height: 24 }} />
        </div>
      </aside>
    </>
  )
}

function Stat({
  icon,
  label,
  value,
  last
}: {
  icon: JSX.Element
  label: string
  value: string
  last?: boolean
}): JSX.Element {
  return (
    <div
      className="between"
      style={{ padding: '11px 14px', borderBottom: last ? 'none' : '2px solid var(--rule)' }}
    >
      <span className="row muted" style={{ gap: 8, fontSize: 13 }}>
        {icon} {label}
      </span>
      <span style={{ fontWeight: 600, fontSize: 13 }}>{value}</span>
    </div>
  )
}
