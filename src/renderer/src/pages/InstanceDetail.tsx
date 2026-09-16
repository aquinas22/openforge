import { useEffect, useState } from 'react'
import {
  Boxes,
  Clock,
  FolderOpen,
  Play,
  RefreshCw,
  Trash2,
  X,
  Loader2,
  CircleStop,
  Download,
  TriangleAlert,
  Terminal,
  MemoryStick,
  Plus,
  Power,
  Search,
  PackageCheck,
  Share2
} from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { api } from '../api'
import { useStore } from '../store/store'
import { cleanError, loaderLabel, playtime, timeAgo } from '../util'
import type { CfMod, InstalledMod } from '@shared/types'

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
  const install = useStore((s) => s.install)
  const deleteInstance = useStore((s) => s.deleteInstance)
  const refreshInstances = useStore((s) => s.refreshInstances)
  const toast = useStore((s) => s.toast)
  const [mods, setMods] = useState<InstalledMod[]>([])
  const [modsLoading, setModsLoading] = useState(false)
  const [modQuery, setModQuery] = useState('')
  const [modResults, setModResults] = useState<CfMod[]>([])
  const [modSearching, setModSearching] = useState(false)
  const [modAction, setModAction] = useState<number | null>(null)

  useEffect(() => {
    if (!id) return
    setModsLoading(true)
    api.listMods(id).then(setMods).catch(() => setMods([])).finally(() => setModsLoading(false))
  }, [id])

  if (!id || !inst) return null
  const folder = `${settings?.gameDir}/instances/${inst.id}`.replace(/\\/g, '/')

  return (
    <>
      <div className="scrim" onClick={() => openDetail(null)} style={{ background: 'rgba(4,5,10,0.5)' }} />
      <aside className="drawer">
        <div style={{ position: 'relative', height: 170, flexShrink: 0 }}>
          {inst.iconUrl ? (
            <img src={inst.iconUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', opacity: 0.55 }} />
          ) : (
            <div
              style={{
                width: '100%',
                height: '100%',
                background: 'var(--slab)'
              }}
            />
          )}
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(12,13,16,0.55)' }} />
          <button className="win-btn" style={{ position: 'absolute', top: 12, right: 12 }} onClick={() => openDetail(null)}>
            <X size={18} />
          </button>
          <h2 style={{ position: 'absolute', bottom: 16, left: 24, fontSize: 26, right: 24 }}>{inst.name}</h2>
        </div>

        <div style={{ padding: 24, overflowY: 'auto', flex: 1 }}>
          <nav className="drawer-nav" aria-label="Instance sections">
            {[
              ['overview', 'Overview'],
              ['mods', `Mods (${mods.length})`],
              ['manage', 'Manage']
            ].map(([section, label]) => (
              <button
                key={section}
                onClick={() => document.getElementById(`${section}-${inst.id}`)?.scrollIntoView({ behavior: 'smooth' })}
              >
                {label}
              </button>
            ))}
          </nav>
          <div id={`overview-${inst.id}`} className="drawer-anchor" />
          <div className="row" style={{ gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
            <span className="chip accent">
              <Boxes size={13} /> {loaderLabel(inst.loader)} {inst.loaderVersion ? `· ${inst.loaderVersion}` : ''}
            </span>
            <span className="chip">{inst.mcVersion}</span>
            {inst.source === 'curseforge' && <span className="chip">CurseForge</span>}
            {st.running && <span className="chip accent">Running</span>}
          </div>

          {inst.note && (
            <div
              className="panel"
              style={{ padding: 14, marginBottom: 20, borderColor: 'rgba(255,207,92,0.3)', background: 'rgba(255,207,92,0.06)' }}
            >
              <div className="row" style={{ gap: 8, color: 'var(--warn)', alignItems: 'flex-start' }}>
                <TriangleAlert size={16} style={{ marginTop: 2, flexShrink: 0 }} />
                <span style={{ fontSize: 13 }}>{inst.note}</span>
              </div>
            </div>
          )}

          <div className="row" style={{ gap: 12, marginBottom: 22 }}>
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

          <div className="panel" style={{ padding: 4, marginBottom: 20 }}>
            <Stat icon={<Clock size={15} />} label="Last played" value={timeAgo(inst.lastPlayed)} />
            <Stat icon={<Play size={15} />} label="Total playtime" value={playtime(inst.totalPlaySeconds)} />
            <Stat icon={<Boxes size={15} />} label="Created" value={timeAgo(inst.createdAt)} last />
          </div>

          <div className="eyebrow" style={{ marginBottom: 10 }}>Memory</div>
          <div className="panel" style={{ padding: 16, marginBottom: 20 }}>
            <div className="between" style={{ marginBottom: 10 }}>
              <span className="row" style={{ gap: 8 }}>
                <MemoryStick size={15} /> Instance allocation
              </span>
              <span className="chip accent">{((inst.ramMb ?? settings?.ramMb ?? 4096) / 1024).toFixed(1)} GB</span>
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
          </div>

          <div id={`mods-${inst.id}`} className="drawer-anchor" />
          <div className="between" style={{ marginBottom: 10 }}>
            <div className="eyebrow" style={{ margin: 0 }}>Mods · {mods.length}</div>
            <button
              className="btn sm primary"
              disabled={st.running}
              onClick={async () => {
                setMods(await api.importMods(inst.id))
                toast('Mod files imported', 'success')
              }}
            >
              <Plus size={14} /> Add .jar
            </button>
          </div>
          <div className="mod-search">
            <div className="input-row">
              <div style={{ position: 'relative', flex: 1 }}>
                <Search size={15} style={{ position: 'absolute', left: 11, top: 11, color: 'var(--muted)' }} />
                <input
                  className="input"
                  style={{ paddingLeft: 34 }}
                  placeholder={`Search ${inst.mcVersion} ${loaderLabel(inst.loader)} mods`}
                  value={modQuery}
                  onChange={(e) => setModQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      setModSearching(true)
                      api.cfSearch({ query: modQuery, gameVersion: inst.mcVersion, kind: 'mod' })
                        .then((result) => setModResults(result.packs))
                        .catch((error) => toast(cleanError(error), 'error'))
                        .finally(() => setModSearching(false))
                    }
                  }}
                />
              </div>
              <button
                className="btn icon"
                title="Search CurseForge"
                disabled={modSearching}
                onClick={() => {
                  setModSearching(true)
                  api.cfSearch({ query: modQuery, gameVersion: inst.mcVersion, kind: 'mod' })
                    .then((result) => setModResults(result.packs))
                    .catch((error) => toast(cleanError(error), 'error'))
                    .finally(() => setModSearching(false))
                }}
              >
                {modSearching ? <Loader2 size={15} className="spin" /> : <Search size={15} />}
              </button>
            </div>
            {modResults.length > 0 && (
              <div className="mod-results panel">
                {modResults.slice(0, 8).map((result) => (
                  <div className="mod-result" key={result.id}>
                    {result.logo ? <img src={result.logo} alt="" /> : <div className="slot" />}
                    <div className="mod-info">
                      <strong>{result.name}</strong>
                      <small>{result.summary}</small>
                    </div>
                    <button
                      className="btn sm primary"
                      disabled={st.running || modAction !== null}
                      onClick={async () => {
                        setModAction(result.id)
                        try {
                          const installed = await api.installCfMod(inst.id, result.id)
                          setMods(installed.mods)
                          const dependencyNote = installed.dependencies.length
                            ? ` plus ${installed.dependencies.length} required dependencies`
                            : ''
                          toast(`Installed ${result.name}${dependencyNote}`, 'success')
                        } catch (error) {
                          toast(cleanError(error), 'error')
                        } finally {
                          setModAction(null)
                        }
                      }}
                    >
                      {modAction === result.id ? <Loader2 size={13} className="spin" /> : <Plus size={13} />}
                      Add
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="panel mod-list" style={{ marginBottom: 20 }}>
            {modsLoading ? (
              <div className="empty" style={{ padding: 24 }}>Reading mods…</div>
            ) : mods.length === 0 ? (
              <div className="empty" style={{ padding: 24 }}>No individual mod files yet.</div>
            ) : mods.map((mod) => (
              <div className={`mod-row${mod.enabled ? '' : ' disabled'}`} key={mod.fileName}>
                <button
                  className={`mod-power${mod.enabled ? ' on' : ''}`}
                  title={mod.enabled ? 'Disable mod' : 'Enable mod'}
                  disabled={st.running}
                  onClick={async () => setMods(await api.toggleMod(inst.id, mod.fileName, !mod.enabled))}
                >
                  <Power size={15} />
                </button>
                <div className="mod-info">
                  <strong>{mod.displayName}</strong>
                  <small>{(mod.size / 1024 / 1024).toFixed(1)} MB · {mod.enabled ? 'Enabled' : 'Disabled'}</small>
                </div>
                <button
                  className="win-btn"
                  title="Remove mod"
                  disabled={st.running}
                  onClick={async () => {
                    if (confirm(`Remove ${mod.displayName} from this instance?`)) {
                      setMods(await api.deleteMod(inst.id, mod.fileName))
                    }
                  }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>

          <div id={`manage-${inst.id}`} className="drawer-anchor" />
          <div className="eyebrow" style={{ marginBottom: 10 }}>
            Manage
          </div>
          <div style={{ display: 'grid', gap: 8 }}>
            <button className="btn" style={{ justifyContent: 'flex-start' }} onClick={() => api.openFolder(folder)}>
              <FolderOpen size={16} /> Open instance folder
            </button>
            <button
              className="btn"
              style={{ justifyContent: 'flex-start' }}
              disabled={st.busy || st.running}
              onClick={() => install(inst.id)}
            >
              <RefreshCw size={16} /> Reinstall / repair files
            </button>
            <button
              className="btn"
              style={{ justifyContent: 'flex-start' }}
              disabled={st.running || modsLoading}
              onClick={async () => {
                setModsLoading(true)
                try {
                  const result = await api.updateMods(inst.id)
                  setMods(result.mods)
                  toast(
                    result.installed.length ? `Updated ${result.installed.length} mods` : 'All managed mods are current',
                    'success'
                  )
                } catch (error) {
                  toast(cleanError(error), 'error')
                } finally {
                  setModsLoading(false)
                }
              }}
            >
              <PackageCheck size={16} /> Check for mod updates
            </button>
            <button
              className="btn"
              style={{ justifyContent: 'flex-start' }}
              disabled={st.running}
              onClick={async () => {
                try {
                  const path = await api.exportPack(inst.id)
                  if (path) toast('Shareable pack exported', 'success')
                } catch (error) {
                  toast(cleanError(error), 'error')
                }
              }}
            >
              <Share2 size={16} /> Export shareable pack
            </button>
            <button
              className="btn danger"
              style={{ justifyContent: 'flex-start' }}
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
