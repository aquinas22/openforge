import { useEffect, useState } from 'react'
import {
  ArrowUpCircle,
  Boxes,
  CircleStop,
  Clock,
  Copy,
  Download,
  ExternalLink,
  FolderOpen,
  Globe,
  Loader2,
  MemoryStick,
  Package,
  Pencil,
  Play,
  RefreshCw,
  Save,
  Share2,
  Terminal,
  Trash2,
  TriangleAlert,
  X
} from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { api } from '../api'
import { useStore, type DetailTab } from '../store/store'
import { cleanError, loaderLabel, playtime, timeAgo } from '../util'
import type { WorldSummary } from '@shared/types'
import { InstanceSetup } from './InstanceSetup'

type Tab = DetailTab

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
  const openDetail = useStore((s) => s.openDetail)
  const openEditor = useStore((s) => s.openEditor)
  const openConsole = useStore((s) => s.openConsole)
  const launch = useStore((s) => s.launch)
  const kill = useStore((s) => s.kill)
  const repair = useStore((s) => s.repair)
  const deleteInstance = useStore((s) => s.deleteInstance)
  const duplicateInstance = useStore((s) => s.duplicateInstance)
  const updatePack = useStore((s) => s.updatePack)
  const refreshInstances = useStore((s) => s.refreshInstances)
  const toast = useStore((s) => s.toast)

  const tab = useStore((s) => s.detailTab)
  const setTab = useStore((s) => s.setDetailTab)
  const [worlds, setWorlds] = useState<WorldSummary[]>([])
  const [serverAddress, setServerAddress] = useState('')

  useEffect(() => {
    if (id && tab === 'worlds') api.listWorlds(id).then(setWorlds).catch(() => setWorlds([]))
  }, [id, tab])

  // Ask the provider whether the pack itself has a newer release.
  useEffect(() => {
    if (!id || !inst?.provider) return
    api.checkPackUpdate(id).then(() => refreshInstances()).catch(() => undefined)
  }, [id, inst?.provider, refreshInstances])

  if (!id || !inst) return null
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
              ['setup', 'Setup'],
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
                    <button className="btn sm" onClick={() => api.openInstanceFolder(inst.id, 'mods')}>
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
                <button className="btn" onClick={() => openEditor(inst.id)}>
                  <Pencil size={16} /> Edit
                </button>
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

              <button className="panel edit-shortcuts" onClick={() => openEditor(inst.id, 'settings')}>
                <MemoryStick size={15} />
                <span>
                  <strong>Memory, Java and version</strong>
                  <small>
                    {inst.ramMb ? `${(inst.ramMb / 1024).toFixed(1)} GB` : 'Automatic memory'} ·{' '}
                    {inst.javaPath ? 'custom Java' : 'automatic Java'} · {loaderLabel(inst.loader)} {inst.mcVersion}
                  </small>
                </span>
                <Pencil size={14} />
              </button>
            </>
          )}

          {tab === 'setup' && <InstanceSetup key={inst.id} inst={inst} running={st.running || st.busy} />}

          {tab === 'worlds' && (
            <>
              <div className="eyebrow" style={{ marginBottom: 10 }}>
                Saved worlds · {worlds.length}
              </div>
              <div className="panel mod-list">
                {worlds.length === 0 ? (
                  <div className="setup-empty">
                    <Globe size={22} />
                    <strong>No worlds yet</strong>
                    <p>Start the game and create one. It will show up here, ready to jump straight into.</p>
                    <button className="btn primary sm" disabled={st.busy || st.running} onClick={() => launch(inst.id)}>
                      <Play size={14} fill="currentColor" /> Play
                    </button>
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
            <div style={{ display: 'grid', gap: 8 }} key={inst.id}>
              <button
                className="btn"
                style={{ justifyContent: 'flex-start' }}
                onClick={() => openEditor(inst.id, 'settings')}
              >
                <Pencil size={16} /> Name, icon, version, memory and Java
              </button>
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

              <button
                className="btn danger"
                style={{ justifyContent: 'flex-start', marginTop: 10 }}
                disabled={st.running}
                onClick={() => {
                  if (confirm(`Delete "${inst.name}"? Its folder, including mods and worlds, moves to the Recycle Bin.`)) {
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
