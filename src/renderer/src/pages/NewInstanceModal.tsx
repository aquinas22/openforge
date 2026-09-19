import { useEffect, useMemo, useState } from 'react'
import { Blocks, Boxes, Flame, Hammer, Loader2, Sparkles, X } from 'lucide-react'
import { api } from '../api'
import { useStore } from '../store/store'
import type { LoaderType } from '@shared/types'

const LOADERS: { key: LoaderType; label: string; icon: JSX.Element; desc: string }[] = [
  { key: 'vanilla', label: 'Vanilla', icon: <Blocks size={18} />, desc: 'Pure Minecraft' },
  { key: 'fabric', label: 'Fabric', icon: <Sparkles size={18} />, desc: 'Lightweight mods' },
  { key: 'forge', label: 'Forge', icon: <Hammer size={18} />, desc: 'The classic mod loader' },
  { key: 'neoforge', label: 'NeoForge', icon: <Flame size={18} />, desc: 'Modern Forge fork' },
  { key: 'quilt', label: 'Quilt', icon: <Boxes size={18} />, desc: 'Fabric-compatible fork' }
]

export function NewInstanceModal({ onClose }: { onClose: () => void }): JSX.Element {
  const versions = useStore((s) => s.versions)
  const latest = useStore((s) => s.latest)
  const createInstance = useStore((s) => s.createInstance)

  const [loader, setLoader] = useState<LoaderType>('vanilla')
  const [showSnapshots, setShowSnapshots] = useState(false)
  const [mcVersion, setMcVersion] = useState('')
  const [name, setName] = useState('')

  const [loaderVersions, setLoaderVersions] = useState<{ version: string; stable: boolean }[]>([])
  const [loaderVersion, setLoaderVersion] = useState('')
  const [loadingLv, setLoadingLv] = useState(false)

  const list = useMemo(
    () => versions.filter((v) => showSnapshots || v.type === 'release'),
    [versions, showSnapshots]
  )
  const selected = mcVersion || latest.release || list[0]?.id || ''

  useEffect(() => {
    if (loader === 'vanilla' || !selected) {
      setLoaderVersions([])
      setLoaderVersion('')
      return
    }
    let cancelled = false
    setLoadingLv(true)
    setLoaderVersions([])
    api
      .loaderVersions(loader, selected)
      .then((v) => {
        if (cancelled) return
        setLoaderVersions(v)
        setLoaderVersion(v[0]?.version ?? '')
      })
      .catch(() => !cancelled && setLoaderVersions([]))
      .finally(() => !cancelled && setLoadingLv(false))
    return () => {
      cancelled = true
    }
  }, [loader, selected])

  const label = LOADERS.find((l) => l.key === loader)!.label
  const defaultName = name.trim() || `${loader === 'vanilla' ? 'Vanilla' : label} ${selected}`
  const needsLoaderVersion = loader === 'forge' || loader === 'neoforge'
  const noBuilds = needsLoaderVersion && !loadingLv && loaderVersions.length === 0
  const canCreate = Boolean(selected) && (!needsLoaderVersion || Boolean(loaderVersion))

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="between" style={{ marginBottom: 20 }}>
          <h2 style={{ fontSize: 22 }}>New instance</h2>
          <button className="win-btn" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div className="field">
          <label>Mod loader</label>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            {LOADERS.map((o) => (
              <button
                key={o.key}
                onClick={() => setLoader(o.key)}
                className="panel"
                style={{
                  padding: 13,
                  textAlign: 'left',
                  cursor: 'pointer',
                  boxShadow:
                    loader === o.key
                      ? 'inset 2px 2px 0 var(--edge-light), inset -2px -2px 0 var(--edge-dark), inset 0 0 0 3px var(--vein)'
                      : undefined
                }}
              >
                <div className="row" style={{ gap: 8, marginBottom: 3 }}>
                  {o.icon}
                  <strong>{o.label}</strong>
                </div>
                <div className="muted" style={{ fontSize: 12 }}>
                  {o.desc}
                </div>
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <div className="between" style={{ marginBottom: 7 }}>
            <label style={{ margin: 0 }}>Minecraft version</label>
            <label className="row muted" style={{ fontSize: 12, gap: 6, cursor: 'pointer' }}>
              <input type="checkbox" checked={showSnapshots} onChange={(e) => setShowSnapshots(e.target.checked)} />
              Show snapshots
            </label>
          </div>
          <select className="select" value={selected} onChange={(e) => setMcVersion(e.target.value)}>
            {list.length === 0 && <option>Loading versions…</option>}
            {list.slice(0, 300).map((v) => (
              <option key={v.id} value={v.id}>
                {v.id}
                {v.id === latest.release ? '  (latest)' : ''}
                {v.type !== 'release' ? `  · ${v.type}` : ''}
              </option>
            ))}
          </select>
        </div>

        {loader !== 'vanilla' && (
          <div className="field">
            <label>{label} version</label>
            {loadingLv ? (
              <div className="row muted" style={{ height: 42, gap: 8 }}>
                <Loader2 size={15} className="spin" /> Fetching {label} builds…
              </div>
            ) : noBuilds ? (
              <div className="chip warn">No {label} builds for {selected}</div>
            ) : (
              <select className="select" value={loaderVersion} onChange={(e) => setLoaderVersion(e.target.value)}>
                {(loader === 'fabric' || loader === 'quilt') && (
                  <option value="">Latest stable (auto)</option>
                )}
                {loaderVersions.map((v) => (
                  <option key={v.version} value={v.version}>
                    {v.version}
                    {v.stable ? '  (recommended)' : ''}
                  </option>
                ))}
              </select>
            )}
          </div>
        )}

        <div className="field">
          <label>Name</label>
          <input className="input" placeholder={defaultName} value={name} onChange={(e) => setName(e.target.value)} />
        </div>

        <div className="row" style={{ justifyContent: 'flex-end', gap: 10, marginTop: 24 }}>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={!canCreate}
            onClick={() => {
              createInstance({
                name: defaultName,
                mcVersion: selected,
                loader,
                loaderVersion: loaderVersion || undefined
              })
              onClose()
            }}
          >
            Create &amp; install
          </button>
        </div>
      </div>
    </div>
  )
}
