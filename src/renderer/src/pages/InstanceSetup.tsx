import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Brush,
  FileCog,
  FileText,
  FolderOpen,
  FolderSearch,
  Keyboard,
  Loader2,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
  TriangleAlert
} from 'lucide-react'
import type { CleanupPlan, ConfigFileEntry, Instance, KeyBinding, KeyBindingReport } from '@shared/types'
import { api } from '../api'
import { useStore } from '../store/store'
import { bytes, cleanError, timeAgo } from '../util'

type Section = 'keys' | 'configs' | 'cleanup'

const SECTIONS: { key: Section; label: string; icon: JSX.Element }[] = [
  { key: 'keys', label: 'Key bindings', icon: <Keyboard size={14} /> },
  { key: 'configs', label: 'Mod configs', icon: <FileCog size={14} /> },
  { key: 'cleanup', label: 'Clean up', icon: <Brush size={14} /> }
]

/**
 * The "Setup" tab of an instance: key bindings from options.txt, the mod
 * config folder, and a trash-only cleanup of logs, caches and leftovers.
 */
export function InstanceSetup({ inst, running }: { inst: Instance; running: boolean }): JSX.Element {
  const [section, setSection] = useState<Section>('keys')
  return (
    <>
      <div className="pill-tabs" role="tablist" aria-label="Setup section">
        {SECTIONS.map((entry) => (
          <button
            key={entry.key}
            role="tab"
            aria-selected={section === entry.key}
            className={section === entry.key ? 'active' : ''}
            onClick={() => setSection(entry.key)}
          >
            {entry.icon} {entry.label}
          </button>
        ))}
      </div>
      <div className="setup-section" key={section}>
        {section === 'keys' && <KeyBindings inst={inst} running={running} />}
        {section === 'configs' && <ModConfigs inst={inst} />}
        {section === 'cleanup' && <Cleanup inst={inst} running={running} />}
      </div>
    </>
  )
}

// -- Key bindings ----------------------------------------------------------------

function KeyBindings({ inst, running }: { inst: Instance; running: boolean }): JSX.Element {
  const toast = useStore((s) => s.toast)
  const launch = useStore((s) => s.launch)
  const [report, setReport] = useState<KeyBindingReport | null>(null)
  const [query, setQuery] = useState('')
  const [onlyConflicts, setOnlyConflicts] = useState(false)
  const [working, setWorking] = useState(false)

  const load = useCallback(async () => {
    try {
      setReport(await api.listKeyBindings(inst.id))
    } catch (e) {
      toast(cleanError(e), 'error')
      setReport({ exists: false, legacy: false, bindings: [], conflicts: [] })
    }
  }, [inst.id, toast])

  useEffect(() => {
    setReport(null)
    load()
  }, [load])

  const reset = async (ids: string[] | null, what: string): Promise<void> => {
    setWorking(true)
    try {
      setReport(await api.resetKeyBindings(inst.id, ids))
      toast(`${what} reset. A backup of options.txt was kept next to it.`, 'success')
    } catch (e) {
      toast(cleanError(e), 'error')
    } finally {
      setWorking(false)
    }
  }

  const groups = useMemo(() => {
    if (!report) return []
    const q = query.trim().toLowerCase()
    const visible = report.bindings.filter(
      (binding) =>
        (!onlyConflicts || binding.conflict) &&
        (!q ||
          binding.label.toLowerCase().includes(q) ||
          binding.keyLabel.toLowerCase().includes(q) ||
          binding.category.toLowerCase().includes(q))
    )
    const byCategory = new Map<string, KeyBinding[]>()
    for (const binding of visible) {
      const list = byCategory.get(binding.category) ?? []
      list.push(binding)
      byCategory.set(binding.category, list)
    }
    // Vanilla groups first, then mods alphabetically.
    return [...byCategory.entries()].sort(([a, la], [b, lb]) => {
      const va = la[0]?.vanilla ? 0 : 1
      const vb = lb[0]?.vanilla ? 0 : 1
      return va - vb || a.localeCompare(b)
    })
  }, [report, query, onlyConflicts])

  if (!report) {
    return (
      <div className="empty" style={{ padding: 24 }}>
        <Loader2 size={18} className="spin" /> Reading options.txt…
      </div>
    )
  }

  if (!report.exists) {
    return (
      <div className="panel setup-empty">
        <Keyboard size={22} />
        <strong>No key bindings yet</strong>
        <p>Minecraft writes options.txt the first time this profile starts. Play once, then come back here.</p>
        <button className="btn primary" disabled={running} onClick={() => launch(inst.id)}>
          <Play size={15} fill="currentColor" /> Play now
        </button>
      </div>
    )
  }

  const conflictCount = report.conflicts.length
  const nameOf = (id: string): string => report.bindings.find((b) => b.id === id)?.label ?? id

  return (
    <>
      {running && (
        <div className="notice warn">
          <TriangleAlert size={16} />
          <div>
            <strong>Minecraft is running</strong>
            <span>The game rewrites options.txt when it closes, so resets are disabled until then.</span>
          </div>
        </div>
      )}

      {conflictCount > 0 && (
        <div className="notice accent">
          <TriangleAlert size={16} />
          <div>
            <strong>
              {conflictCount} key{conflictCount === 1 ? '' : 's'} bound to more than one action
            </strong>
            <span>
              {report.conflicts
                .slice(0, 3)
                .map((c) => `${c.keyLabel}: ${c.ids.map(nameOf).join(', ')}`)
                .join(' · ')}
              {conflictCount > 3 ? ' …' : ''}
            </span>
          </div>
          <button className="btn sm" onClick={() => setOnlyConflicts((v) => !v)}>
            {onlyConflicts ? 'Show all' : 'Show conflicts'}
          </button>
        </div>
      )}

      <div className="setup-toolbar">
        <div className="search-field">
          <Search size={15} />
          <input
            className="input"
            placeholder="Search actions or keys…"
            aria-label="Search key bindings"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <button className="btn sm" onClick={() => api.openOptionsFile(inst.id).catch((e) => toast(cleanError(e), 'error'))}>
          <FileText size={14} /> Open options.txt
        </button>
        <button
          className="btn sm danger"
          disabled={running || working}
          onClick={() => {
            if (confirm('Reset every key binding in this profile to its default? Mods restore their own defaults on the next start.')) {
              reset(null, 'All key bindings')
            }
          }}
        >
          <RotateCcw size={14} /> Reset all
        </button>
      </div>

      {report.legacy && (
        <p className="hint" style={{ margin: '0 0 10px' }}>
          This is a pre-1.13 profile. Reset removes a binding, and the game writes its default back on the next start.
        </p>
      )}

      <div className="panel keybind-table">
        {groups.length === 0 ? (
          <div className="empty" style={{ padding: 20 }}>
            {onlyConflicts ? 'No conflicts match this search.' : 'No bindings match this search.'}
          </div>
        ) : (
          groups.map(([category, bindings]) => (
            <section key={category}>
              <div className="keybind-group">
                {category}
                <small>{bindings.length}</small>
              </div>
              {bindings.map((binding) => (
                <div className={`keybind-row${binding.conflict ? ' conflict' : ''}`} key={binding.id}>
                  <div className="keybind-name">
                    <strong>{binding.label}</strong>
                    <small title={binding.id}>{binding.id}</small>
                  </div>
                  <span className="keycap" title={binding.key}>
                    {binding.keyLabel}
                  </span>
                  <span className="keybind-default">
                    {binding.isDefault
                      ? 'Default'
                      : binding.defaultLabel
                        ? `Default: ${binding.defaultLabel}`
                        : binding.conflict
                          ? 'Conflict'
                          : ''}
                  </span>
                  <button
                    className="win-btn"
                    title={binding.isDefault ? 'Already the default' : `Reset ${binding.label}`}
                    aria-label={`Reset ${binding.label}`}
                    disabled={running || working || binding.isDefault}
                    onClick={() => reset([binding.id], binding.label)}
                  >
                    <RotateCcw size={13} />
                  </button>
                </div>
              ))}
            </section>
          ))
        )}
      </div>
    </>
  )
}

// -- Mod configs -------------------------------------------------------------------

function ModConfigs({ inst }: { inst: Instance }): JSX.Element {
  const toast = useStore((s) => s.toast)
  const [files, setFiles] = useState<ConfigFileEntry[] | null>(null)
  const [query, setQuery] = useState('')

  const load = useCallback(async () => {
    setFiles(null)
    try {
      setFiles(await api.listConfigFiles(inst.id))
    } catch (e) {
      toast(cleanError(e), 'error')
      setFiles([])
    }
  }, [inst.id, toast])

  useEffect(() => {
    load()
  }, [load])

  const open = (relPath: string, reveal = false): void => {
    api.openConfigFile(inst.id, relPath, reveal).catch((e) => toast(cleanError(e), 'error'))
  }

  const visible = (files ?? []).filter((file) => {
    const q = query.trim().toLowerCase()
    return !q || file.relPath.toLowerCase().includes(q) || file.owner.toLowerCase().includes(q)
  })
  const orphans = (files ?? []).filter((file) => file.orphan).length

  return (
    <>
      <div className="setup-toolbar">
        <div className="search-field">
          <Search size={15} />
          <input
            className="input"
            placeholder="Search configs or mods…"
            aria-label="Search config files"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <button
          className="btn sm"
          onClick={() => api.openInstanceFolder(inst.id, 'config').catch((e) => toast(cleanError(e), 'error'))}
        >
          <FolderOpen size={14} /> Open config folder
        </button>
        <button className="btn sm ghost" title="Rescan" aria-label="Rescan config files" onClick={load}>
          <RefreshCw size={14} />
        </button>
      </div>

      {orphans > 0 && (
        <p className="hint" style={{ margin: '0 0 10px' }}>
          {orphans} file{orphans === 1 ? '' : 's'} may belong to mods that are no longer installed. Clean up can move them to
          the Recycle Bin.
        </p>
      )}

      <div className="panel mod-list">
        {files === null ? (
          <div className="empty" style={{ padding: 24 }}>
            <Loader2 size={18} className="spin" /> Reading config folder…
          </div>
        ) : files.length === 0 ? (
          <div className="setup-empty">
            <FileCog size={22} />
            <strong>No config files yet</strong>
            <p>Mods create their configs the first time the game starts with them installed.</p>
          </div>
        ) : visible.length === 0 ? (
          <div className="empty" style={{ padding: 24 }}>
            No config files match this search.
          </div>
        ) : (
          visible.map((file) => (
            <div className="mod-row config-row" key={file.relPath}>
              <FileText size={15} className="muted" />
              <button className="mod-info config-open" title={`Open ${file.relPath}`} onClick={() => open(file.relPath)}>
                <strong>{file.relPath.replace(/^config\//, '')}</strong>
                <small>
                  {file.owner} · {bytes(file.size)} · edited {timeAgo(new Date(file.modified).toISOString())}
                </small>
              </button>
              {file.orphan && (
                <span className="chip warn tiny" title="No installed mod matches this config">
                  Unused?
                </span>
              )}
              <button
                className="win-btn"
                title="Show in folder"
                aria-label={`Show ${file.relPath} in its folder`}
                onClick={() => open(file.relPath, true)}
              >
                <FolderSearch size={14} />
              </button>
            </div>
          ))
        )}
      </div>
    </>
  )
}

// -- Cleanup -------------------------------------------------------------------------

function Cleanup({ inst, running }: { inst: Instance; running: boolean }): JSX.Element {
  const toast = useStore((s) => s.toast)
  const [plan, setPlan] = useState<CleanupPlan | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [confirming, setConfirming] = useState(false)
  const [working, setWorking] = useState(false)

  const scan = useCallback(async () => {
    setPlan(null)
    setConfirming(false)
    try {
      const next = await api.planCleanup(inst.id)
      setPlan(next)
      setSelected(new Set(next.items.filter((item) => item.recommended).map((item) => item.relPath)))
    } catch (e) {
      toast(cleanError(e), 'error')
      setPlan({ items: [], totalBytes: 0 })
    }
  }, [inst.id, toast])

  useEffect(() => {
    scan()
  }, [scan])

  if (!plan) {
    return (
      <div className="empty" style={{ padding: 24 }}>
        <Loader2 size={18} className="spin" /> Measuring logs, caches and configs…
      </div>
    )
  }

  const chosen = plan.items.filter((item) => selected.has(item.relPath))
  const chosenBytes = chosen.reduce((sum, item) => sum + item.bytes, 0)
  const toggle = (relPath: string): void => {
    setConfirming(false)
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(relPath)) next.delete(relPath)
      else next.add(relPath)
      return next
    })
  }

  const run = async (): Promise<void> => {
    setWorking(true)
    try {
      const result = await api.runCleanup(
        inst.id,
        chosen.map((item) => item.relPath)
      )
      if (result.trashed.length) {
        toast(`Moved ${result.trashed.length} item${result.trashed.length === 1 ? '' : 's'} (${bytes(result.bytes)}) to the Recycle Bin`, 'success')
      }
      if (result.failed.length) {
        toast(`${result.failed.length} could not be moved: ${result.failed[0].error}`, 'error')
      }
    } catch (e) {
      toast(cleanError(e), 'error')
    } finally {
      setWorking(false)
      scan()
    }
  }

  if (plan.items.length === 0) {
    return (
      <div className="panel setup-empty">
        <Brush size={22} />
        <strong>Nothing to clean up</strong>
        <p>No old logs, crash reports, caches or leftover configs in this profile.</p>
        <button className="btn sm" onClick={scan}>
          <RefreshCw size={14} /> Scan again
        </button>
      </div>
    )
  }

  const groups: [string, typeof plan.items][] = [
    ['Logs and caches', plan.items.filter((item) => item.category !== 'orphan-config')],
    ['Configs for mods that are not installed', plan.items.filter((item) => item.category === 'orphan-config')]
  ]

  return (
    <>
      <p className="hint" style={{ margin: '0 0 12px' }}>
        Everything here goes to the Recycle Bin, so it can be restored. Nothing is deleted outright. Worlds, screenshots and
        mods are never listed.
      </p>
      {groups.map(([title, items]) =>
        items.length ? (
          <div key={title} style={{ marginBottom: 14 }}>
            <div className="eyebrow" style={{ marginBottom: 8 }}>
              {title}
            </div>
            <div className="panel mod-list">
              {items.map((item) => (
                <label className="mod-row cleanup-row" key={item.relPath}>
                  <input
                    type="checkbox"
                    checked={selected.has(item.relPath)}
                    disabled={running || working}
                    onChange={() => toggle(item.relPath)}
                  />
                  <div className="mod-info">
                    <strong>{item.label}</strong>
                    <small>
                      {item.relPath} · {item.files} file{item.files === 1 ? '' : 's'} · {item.reason}
                    </small>
                  </div>
                  <span className="cleanup-size">{bytes(item.bytes)}</span>
                </label>
              ))}
            </div>
          </div>
        ) : null
      )}

      <div className="cleanup-footer panel">
        <div>
          <strong>{chosen.length ? `${bytes(chosenBytes)} selected` : 'Nothing selected'}</strong>
          <small>
            {chosen.length} of {plan.items.length} items · {bytes(plan.totalBytes)} found in total
          </small>
        </div>
        {confirming ? (
          <div className="row" style={{ gap: 8 }}>
            <button className="btn sm ghost" disabled={working} onClick={() => setConfirming(false)}>
              Cancel
            </button>
            <button className="btn sm danger" disabled={working} onClick={run}>
              {working ? <Loader2 size={14} className="spin" /> : <Trash2 size={14} />} Move {chosen.length} to Recycle Bin
            </button>
          </div>
        ) : (
          <button
            className="btn sm primary"
            disabled={running || working || chosen.length === 0}
            title={running ? 'Close Minecraft first' : undefined}
            onClick={() => setConfirming(true)}
          >
            <Brush size={14} /> Clean up…
          </button>
        )}
      </div>
    </>
  )
}
