import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  CircleStop,
  Cloud,
  FolderOpen,
  HardDrive,
  KeyRound,
  Loader2,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  ScrollText,
  Send,
  Server as ServerIcon,
  Skull,
  Trash2,
  TriangleAlert,
  Users,
  Wifi,
  X
} from 'lucide-react'
import { api } from '../api'
import { useStore } from '../store/store'
import { cleanError } from '../util'
import type {
  LocalServerConfig,
  ServerConfig,
  ServerFolderInfo,
  ServerLogLine,
  ServerStatus,
  SshControl,
  SshServerConfig,
  SshTestResult
} from '@shared/types'
import type { ServerConfigInput } from '@shared/ipc'
import { presetCommands } from '@shared/ssh'

const STATE_LABEL: Record<ServerStatus['state'], string> = {
  stopped: 'Stopped',
  starting: 'Starting',
  running: 'Running',
  stopping: 'Stopping',
  unknown: 'Unknown',
  error: 'Problem'
}

function useNow(ms: number): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms)
    return () => window.clearInterval(t)
  }, [ms])
  return now
}

function uptime(since: number | undefined, now: number): string {
  if (!since) return '-'
  const s = Math.max(0, Math.floor((now - since) / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`
}

function where(cfg: ServerConfig): string {
  return cfg.kind === 'local' ? cfg.dir : `${cfg.user}@${cfg.host}${cfg.port !== 22 ? `:${cfg.port}` : ''}`
}

export function Servers(): JSX.Element {
  const toast = useStore((s) => s.toast)
  const [configs, setConfigs] = useState<ServerConfig[]>([])
  const [statuses, setStatuses] = useState<Record<string, ServerStatus>>({})
  const [selected, setSelected] = useState<string | null>(null)
  const [editing, setEditing] = useState<ServerConfig | 'new' | null>(null)

  const load = useCallback(async () => {
    const [list, stats] = await Promise.all([api.listServers(), api.serverStatuses()])
    setConfigs(list)
    setStatuses(Object.fromEntries(stats.map((s) => [s.id, s])))
    setSelected((current) => (current && list.some((c) => c.id === current) ? current : list[0]?.id ?? null))
  }, [])

  useEffect(() => {
    load().catch((e) => toast(cleanError(e), 'error'))
    return api.onServerStatus((s) => setStatuses((prev) => ({ ...prev, [s.id]: s })))
  }, [load, toast])

  const current = configs.find((c) => c.id === selected) ?? null

  return (
    <div className="page servers-page">
      <div className="page-head">
        <div>
          <div className="eyebrow">Hosting</div>
          <h1 className="page-title">Servers</h1>
          <p className="page-subtitle">Run a server on this PC, or control one over SSH.</p>
        </div>
        <button className="btn primary" onClick={() => setEditing('new')}>
          <Plus size={15} /> Add server
        </button>
      </div>

      {configs.length === 0 ? (
        <div className="empty search-empty">
          <ServerIcon size={28} />
          <h3>No servers yet</h3>
          <p>Point Openforge at a server folder, create a fresh vanilla server, or add one you reach over SSH.</p>
          <button className="btn primary" style={{ marginTop: 14 }} onClick={() => setEditing('new')}>
            <Plus size={15} /> Add server
          </button>
        </div>
      ) : (
        <div className="servers-layout">
          <div className="server-list" role="listbox" aria-label="Servers">
            {configs.map((cfg) => {
              const st = statuses[cfg.id]
              return (
                <button
                  key={cfg.id}
                  role="option"
                  aria-selected={cfg.id === selected}
                  className={`panel server-item${cfg.id === selected ? ' active' : ''}`}
                  onClick={() => setSelected(cfg.id)}
                >
                  <span className={`server-dot ${st?.state ?? 'unknown'}`} aria-hidden="true" />
                  <span className="server-item-copy">
                    <strong>{cfg.name}</strong>
                    <small>
                      {cfg.kind === 'local' ? <HardDrive size={11} /> : <Cloud size={11} />} {STATE_LABEL[st?.state ?? (cfg.kind === 'local' ? 'stopped' : 'unknown')]}
                      {st?.players && st.state === 'running' ? ` · ${st.players.online} online` : ''}
                    </small>
                  </span>
                </button>
              )
            })}
          </div>
          {current && (
            <ServerDetail
              key={current.id}
              cfg={current}
              status={statuses[current.id]}
              onEdit={() => setEditing(current)}
              onDeleted={() => load()}
            />
          )}
        </div>
      )}

      {editing && (
        <ServerForm
          initial={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async (cfg) => {
            setEditing(null)
            await load()
            setSelected(cfg.id)
          }}
        />
      )}
    </div>
  )
}

// -- One server -------------------------------------------------------------------------

function ServerDetail({
  cfg,
  status,
  onEdit,
  onDeleted
}: {
  cfg: ServerConfig
  status: ServerStatus | undefined
  onEdit: () => void
  onDeleted: () => void
}): JSX.Element {
  const toast = useStore((s) => s.toast)
  const now = useNow(1000)
  const [lines, setLines] = useState<ServerLogLine[]>([])
  const [command, setCommand] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const [historyAt, setHistoryAt] = useState(-1)
  const [busy, setBusy] = useState<string | null>(null)
  const [folder, setFolder] = useState<ServerFolderInfo | null>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  useEffect(() => {
    api.serverLog(cfg.id).then(setLines).catch(() => setLines([]))
    const off = api.onServerLog((line) => {
      if (line.serverId !== cfg.id) return
      setLines((prev) => (prev.length > 1500 ? [...prev.slice(-1200), line] : [...prev, line]))
    })
    if (cfg.kind === 'ssh') api.refreshServer(cfg.id).catch(() => undefined)
    if (cfg.kind === 'local') api.inspectServerFolder(cfg.dir).then(setFolder).catch(() => setFolder(null))
    return off
  }, [cfg])

  useEffect(() => {
    if (stick.current && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [lines])

  const state = status?.state ?? (cfg.kind === 'local' ? 'stopped' : 'unknown')
  const live = state === 'running' || state === 'starting' || state === 'stopping'

  const run = async (label: string, work: () => Promise<unknown>): Promise<void> => {
    setBusy(label)
    try {
      await work()
    } catch (e) {
      toast(cleanError(e), 'error')
    } finally {
      setBusy(null)
    }
  }

  const sendLine = async (): Promise<void> => {
    const line = command.trim()
    if (!line) return
    setCommand('')
    setHistory((h) => [line, ...h.filter((x) => x !== line)].slice(0, 50))
    setHistoryAt(-1)
    await run('send', () => api.sendServerCommand(cfg.id, line))
  }

  const needsEula = cfg.kind === 'local' && cfg.launch === 'jar' && folder?.exists && !folder.eulaAccepted

  return (
    <div className="panel server-detail">
      <div className="server-head">
        <div className="server-title">
          <div className="row" style={{ gap: 8 }}>
            <span className={`server-dot ${state}`} aria-hidden="true" />
            <h2>{cfg.name}</h2>
            <span className={`chip ${state === 'running' ? 'accent' : state === 'error' ? 'warn' : ''}`}>{STATE_LABEL[state]}</span>
          </div>
          <small className="muted">
            {cfg.kind === 'local' ? <HardDrive size={12} /> : <Cloud size={12} />} {where(cfg)}
            {cfg.kind === 'ssh' ? ` · ${cfg.control === 'systemd' ? `systemd ${cfg.unit}` : `${cfg.control} ${cfg.session}`}` : ` · ${cfg.file}`}
          </small>
        </div>
        <div className="row" style={{ gap: 6 }}>
          <button className="btn sm icon" title="Edit" aria-label="Edit server" onClick={onEdit} disabled={cfg.kind === 'local' && live}>
            <Pencil size={14} />
          </button>
          <button
            className="btn sm icon"
            title="Remove from Openforge (the folder is kept)"
            aria-label="Remove server"
            disabled={cfg.kind === 'local' && live}
            onClick={() => {
              if (confirm(`Remove ${cfg.name} from Openforge? Its files are not touched.`)) {
                void run('delete', async () => {
                  await api.deleteServer(cfg.id)
                  onDeleted()
                })
              }
            }}
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      <div className="server-stats">
        <div>
          <small>Status</small>
          <strong>{STATE_LABEL[state]}</strong>
        </div>
        <div>
          <small>
            <Users size={11} /> Players
          </small>
          <strong title={status?.players?.names.join(', ')}>
            {state === 'running' && status?.players
              ? `${status.players.online}${status.players.max ? ` / ${status.players.max}` : ''}`
              : '-'}
          </strong>
        </div>
        <div>
          <small>Uptime</small>
          <strong>{live ? uptime(status?.startedAt, now) : '-'}</strong>
        </div>
      </div>
      {status?.players && status.players.names.length > 0 && state === 'running' && (
        <div className="server-players">{status.players.names.join(', ')}</div>
      )}
      {status?.message && state === 'error' && (
        <div className="notice danger" style={{ margin: '0 0 12px' }}>
          <TriangleAlert size={16} />
          <div>
            <strong>Something went wrong</strong>
            <span>{status.message}</span>
          </div>
        </div>
      )}
      {needsEula && (
        <div className="notice warn" style={{ margin: '0 0 12px' }}>
          <TriangleAlert size={16} />
          <div>
            <strong>The Minecraft EULA has not been accepted in this folder</strong>
            <span>The server stops right after starting until eula.txt says eula=true. Read the EULA at aka.ms/MinecraftEULA.</span>
          </div>
          <div className="row" style={{ gap: 6 }}>
            <button className="btn sm ghost" onClick={() => api.openExternal('https://aka.ms/MinecraftEULA')}>
              Read
            </button>
            <button
              className="btn sm"
              onClick={() =>
                run('eula', async () => {
                  await api.acceptServerEula(cfg.id)
                  setFolder(await api.inspectServerFolder((cfg as LocalServerConfig).dir))
                })
              }
            >
              I accept
            </button>
          </div>
        </div>
      )}

      <div className="server-actions">
        {!live || cfg.kind === 'ssh' ? (
          <button
            className="btn primary"
            disabled={busy !== null || (cfg.kind === 'local' && live) || state === 'running'}
            onClick={() => run('start', () => api.startServer(cfg.id))}
          >
            {busy === 'start' ? <Loader2 size={15} className="spin" /> : <Play size={15} />} Start
          </button>
        ) : null}
        <button
          className="btn"
          disabled={busy !== null || (cfg.kind === 'local' ? !live || state === 'stopping' : state === 'stopped')}
          onClick={() => run('stop', () => api.stopServer(cfg.id))}
        >
          {busy === 'stop' || state === 'stopping' ? <Loader2 size={15} className="spin" /> : <CircleStop size={15} />} Stop
        </button>
        {cfg.kind === 'local' && live && (
          <button
            className="btn danger"
            title="Kill the process now, without saving"
            onClick={() => {
              if (confirm('Kill the server now? Anything not yet saved is lost.')) void run('kill', () => api.killServer(cfg.id))
            }}
          >
            <Skull size={15} /> Kill
          </button>
        )}
        {cfg.kind === 'ssh' && (
          <>
            <button className="btn" disabled={busy !== null} onClick={() => run('refresh', () => api.refreshServer(cfg.id))}>
              {busy === 'refresh' ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />} Check status
            </button>
            <button
              className={`btn${status?.tailing ? ' primary' : ''}`}
              onClick={() => run('tail', () => api.tailServerLog(cfg.id, !status?.tailing))}
            >
              <ScrollText size={15} /> {status?.tailing ? 'Stop log' : 'Tail log'}
            </button>
          </>
        )}
        {cfg.kind === 'local' && (
          <button className="btn icon" title="Open the server folder" onClick={() => api.openFolder(cfg.dir)}>
            <FolderOpen size={15} />
          </button>
        )}
      </div>

      <div
        className="server-console"
        ref={logRef}
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }}
      >
        {lines.length === 0 ? (
          <div className="muted">
            {cfg.kind === 'ssh' ? 'Press Tail log to stream the server log over SSH.' : 'Console output appears here once the server starts.'}
          </div>
        ) : (
          lines.map((l, i) => (
            <div key={i} className={`l-${l.stream}`}>
              {l.line}
            </div>
          ))
        )}
      </div>
      <form
        className="server-input"
        onSubmit={(e) => {
          e.preventDefault()
          void sendLine()
        }}
      >
        <span className="server-prompt">&gt;</span>
        <input
          className="input"
          placeholder={cfg.kind === 'ssh' && cfg.control === 'systemd' && !cfg.sendCommand ? 'Needs a custom send command for systemd' : 'Type a command, e.g. say hi, list, stop'}
          value={command}
          aria-label="Server command"
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowUp' && history.length) {
              e.preventDefault()
              const next = Math.min(history.length - 1, historyAt + 1)
              setHistoryAt(next)
              setCommand(history[next])
            } else if (e.key === 'ArrowDown') {
              e.preventDefault()
              const next = historyAt - 1
              setHistoryAt(Math.max(-1, next))
              setCommand(next >= 0 ? history[next] : '')
            }
          }}
          disabled={cfg.kind === 'local' && !live}
        />
        <button className="btn primary" type="submit" disabled={!command.trim() || busy === 'send' || (cfg.kind === 'local' && !live)}>
          {busy === 'send' ? <Loader2 size={15} className="spin" /> : <Send size={15} />} Send
        </button>
      </form>
    </div>
  )
}

// -- Add / edit ----------------------------------------------------------------------------

type FormKind = 'local' | 'create' | 'ssh'

function ServerForm({
  initial,
  onClose,
  onSaved
}: {
  initial: ServerConfig | null
  onClose: () => void
  onSaved: (cfg: ServerConfig) => void
}): JSX.Element {
  const toast = useStore((s) => s.toast)
  const systemInfo = useStore((s) => s.systemInfo)
  const java = useStore((s) => s.java)
  const versions = useStore((s) => s.versions)
  const latest = useStore((s) => s.latest)
  const [kind, setKind] = useState<FormKind>(initial?.kind ?? 'local')
  const [saving, setSaving] = useState(false)

  const localInit = initial?.kind === 'local' ? initial : null
  const sshInit = initial?.kind === 'ssh' ? initial : null
  const [name, setName] = useState(initial?.name ?? '')

  // Local
  const [dir, setDir] = useState(localInit?.dir ?? '')
  const [folder, setFolder] = useState<ServerFolderInfo | null>(null)
  const [launch, setLaunch] = useState<'jar' | 'script'>(localInit?.launch ?? 'jar')
  const [file, setFile] = useState(localInit?.file ?? '')
  const [javaPath, setJavaPath] = useState(localInit?.javaPath ?? '')
  const [ramMb, setRamMb] = useState(localInit?.ramMb ?? 2048)
  const [jvmArgs, setJvmArgs] = useState(localInit?.jvmArgs ?? '')
  const [stopTimeoutSec, setStopTimeoutSec] = useState(localInit?.stopTimeoutSec ?? 45)

  // Create
  const [mcVersion, setMcVersion] = useState(latest.release)
  const [eula, setEula] = useState(false)

  // SSH
  const [ssh, setSsh] = useState<Omit<SshServerConfig, 'id' | 'createdAt' | 'name' | 'kind'>>({
    host: sshInit?.host ?? '',
    port: sshInit?.port ?? 22,
    user: sshInit?.user ?? '',
    identityFile: sshInit?.identityFile ?? '',
    control: sshInit?.control ?? 'tmux',
    session: sshInit?.session ?? 'mc',
    unit: sshInit?.unit ?? 'minecraft',
    serverDir: sshInit?.serverDir ?? '~/server',
    startScript: sshInit?.startScript ?? './run.sh',
    logPath: sshInit?.logPath ?? '',
    startCommand: sshInit?.startCommand ?? '',
    stopCommand: sshInit?.stopCommand ?? '',
    statusCommand: sshInit?.statusCommand ?? '',
    sendCommand: sshInit?.sendCommand ?? '',
    tailCommand: sshInit?.tailCommand ?? ''
  })
  const [testing, setTesting] = useState(false)
  const [test, setTest] = useState<SshTestResult | null>(null)
  const [showCommands, setShowCommands] = useState(Boolean(sshInit && (sshInit.startCommand || sshInit.stopCommand || sshInit.statusCommand || sshInit.sendCommand || sshInit.tailCommand)))
  const setS = <K extends keyof typeof ssh>(key: K, value: (typeof ssh)[K]): void => {
    setSsh((prev) => ({ ...prev, [key]: value }))
    setTest(null)
  }

  useEffect(() => {
    if (!dir) {
      setFolder(null)
      return
    }
    let cancelled = false
    api.inspectServerFolder(dir).then((info) => {
      if (cancelled) return
      setFolder(info)
      // Pick something sensible when nothing is chosen yet (or the choice vanished).
      if (launch === 'jar' && !info.jars.includes(file)) setFile(info.jars[0] ?? '')
      if (launch === 'script' && !info.scripts.includes(file)) setFile(info.scripts[0] ?? '')
      if (!localInit && !info.jars.length && info.scripts.length) {
        setLaunch('script')
        setFile(info.scripts[0])
      }
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dir, launch])

  const preview = useMemo(() => {
    try {
      const cmds = presetCommands({ ...ssh, id: '', createdAt: '', name: '', kind: 'ssh' })
      return { start: cmds.start, stop: cmds.stop, status: cmds.status, send: cmds.send('say hi') ?? '(not available for systemd)', tail: cmds.tail }
    } catch {
      return null
    }
  }, [ssh])

  async function save(): Promise<void> {
    setSaving(true)
    try {
      let cfg: ServerConfig
      if (kind === 'create') {
        if (!eula) throw new Error('Accept the Minecraft EULA to create a server.')
        cfg = await api.createLocalServer({ name, dir, mcVersion, ramMb, acceptEula: eula })
        toast(`${cfg.name} is ready. Press Start.`, 'success')
      } else {
        const input: ServerConfigInput =
          kind === 'local'
            ? { id: initial?.id, kind: 'local', name, dir, launch, file, javaPath, ramMb, jvmArgs, stopTimeoutSec }
            : { id: initial?.id, kind: 'ssh', name, ...ssh, port: Number(ssh.port) }
        cfg = await api.saveServer(input)
      }
      onSaved(cfg)
    } catch (e) {
      toast(cleanError(e), 'error')
    } finally {
      setSaving(false)
    }
  }

  const maxRam = systemInfo?.maxRamMb ?? 8192
  const releases = versions.filter((v) => v.type === 'release').slice(0, 80)

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal server-form" role="dialog" aria-label={initial ? `Edit ${initial.name}` : 'Add a server'}>
        <div className="between" style={{ marginBottom: 16 }}>
          <div>
            <div className="eyebrow">{initial ? 'Edit server' : 'New server'}</div>
            <h2 style={{ fontSize: 20 }}>{initial ? initial.name : 'Add a server'}</h2>
          </div>
          <button className="win-btn" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        {!initial && (
          <div className="segmented" role="tablist" style={{ marginBottom: 16 }}>
            {(
              [
                ['local', 'Existing folder'],
                ['create', 'New vanilla server'],
                ['ssh', 'Over SSH']
              ] as [FormKind, string][]
            ).map(([key, label]) => (
              <button key={key} role="tab" aria-selected={kind === key} className={kind === key ? 'active' : ''} onClick={() => setKind(key)}>
                {label}
              </button>
            ))}
          </div>
        )}

        <div className="field">
          <label htmlFor="srv-name">Name</label>
          <input id="srv-name" className="input" value={name} maxLength={60} placeholder="Survival with friends" onChange={(e) => setName(e.target.value)} />
        </div>

        {(kind === 'local' || kind === 'create') && (
          <div className="field">
            <label htmlFor="srv-dir">{kind === 'create' ? 'Folder for the new server' : 'Server folder'}</label>
            <div className="input-row">
              <input id="srv-dir" className="input" value={dir} placeholder="D:\\Minecraft\\server" onChange={(e) => setDir(e.target.value.trim())} />
              <button
                className="btn"
                onClick={async () => {
                  const picked = await api.pickDirectory()
                  if (picked) setDir(picked)
                }}
              >
                <FolderOpen size={14} /> Browse
              </button>
            </div>
            {kind === 'local' && folder && !folder.exists && dir && <div className="hint">That folder does not exist.</div>}
            {kind === 'local' && folder?.exists && !folder.jars.length && !folder.scripts.length && (
              <div className="hint">No server jar or start script here. Pick the folder that holds server.jar or run.bat.</div>
            )}
          </div>
        )}

        {kind === 'create' && (
          <>
            <div className="field">
              <label htmlFor="srv-version">Minecraft version</label>
              <select id="srv-version" className="select" value={mcVersion} onChange={(e) => setMcVersion(e.target.value)}>
                {releases.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.id}
                  </option>
                ))}
              </select>
              <div className="hint">Downloads Mojang&apos;s official server.jar (vanilla). For Fabric or Forge, install the server with their installer, then add the folder.</div>
            </div>
            <label className="check-row" style={{ marginBottom: 16 }}>
              <input type="checkbox" checked={eula} onChange={(e) => setEula(e.target.checked)} /> I accept the{' '}
              <button className="link-button" type="button" onClick={() => api.openExternal('https://aka.ms/MinecraftEULA')}>
                Minecraft EULA
              </button>
            </label>
          </>
        )}

        {kind === 'local' && (
          <div className="field">
            <label htmlFor="srv-file">Start with</label>
            <div className="input-row">
              <select className="select" style={{ maxWidth: 190 }} value={launch} onChange={(e) => setLaunch(e.target.value as 'jar' | 'script')} aria-label="Launch type">
                <option value="jar">Server jar</option>
                <option value="script">Start script</option>
              </select>
              <select id="srv-file" className="select" value={file} onChange={(e) => setFile(e.target.value)}>
                {(launch === 'jar' ? folder?.jars : folder?.scripts)?.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                )) ?? null}
                {!(launch === 'jar' ? folder?.jars : folder?.scripts)?.length && <option value="">Nothing found</option>}
              </select>
            </div>
            <div className="hint">
              {launch === 'jar'
                ? 'Openforge runs the jar with the Java and memory below.'
                : 'Forge and NeoForge servers start with run.bat; memory comes from user_jvm_args.txt. The Java below is put first on PATH.'}
            </div>
          </div>
        )}

        {(kind === 'local' || kind === 'create') && (
          <>
            {kind === 'local' && (
              <div className="field">
                <label htmlFor="srv-java">Java</label>
                <select id="srv-java" className="select" value={javaPath} onChange={(e) => setJavaPath(e.target.value)}>
                  <option value="">Automatic - the version the server jar asks for</option>
                  {java.map((j) => (
                    <option key={j.path} value={j.path}>
                      Java {j.majorVersion} ({j.version}) - {j.path}
                    </option>
                  ))}
                  {javaPath && !java.some((j) => j.path === javaPath) && <option value={javaPath}>{javaPath}</option>}
                </select>
              </div>
            )}
            <div className="field">
              <div className="between" style={{ marginBottom: 7 }}>
                <label style={{ margin: 0 }} htmlFor="srv-ram">
                  Memory
                </label>
                <span className="chip accent">{(ramMb / 1024).toFixed(1)} GB</span>
              </div>
              <input id="srv-ram" className="slider" type="range" min={1024} max={maxRam} step={256} value={Math.min(ramMb, maxRam)} onChange={(e) => setRamMb(Number(e.target.value))} />
            </div>
            {kind === 'local' && (
              <div className="row" style={{ gap: 12 }}>
                <div className="field" style={{ flex: 2 }}>
                  <label htmlFor="srv-jvm">Extra JVM arguments</label>
                  <input id="srv-jvm" className="input" value={jvmArgs} placeholder="-XX:+UseG1GC" onChange={(e) => setJvmArgs(e.target.value)} />
                </div>
                <div className="field" style={{ flex: 1 }}>
                  <label htmlFor="srv-timeout">Stop timeout (s)</label>
                  <input id="srv-timeout" className="input" type="number" min={5} max={600} value={stopTimeoutSec} onChange={(e) => setStopTimeoutSec(Number(e.target.value))} />
                </div>
              </div>
            )}
          </>
        )}

        {kind === 'ssh' && (
          <>
            <div className="row" style={{ gap: 12 }}>
              <div className="field" style={{ flex: 3 }}>
                <label htmlFor="srv-host">Host</label>
                <input id="srv-host" className="input" value={ssh.host} placeholder="mc.example.net" onChange={(e) => setS('host', e.target.value.trim())} />
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label htmlFor="srv-port">Port</label>
                <input id="srv-port" className="input" type="number" min={1} max={65535} value={ssh.port} onChange={(e) => setS('port', Number(e.target.value))} />
              </div>
              <div className="field" style={{ flex: 2 }}>
                <label htmlFor="srv-user">User</label>
                <input id="srv-user" className="input" value={ssh.user} placeholder="minecraft" onChange={(e) => setS('user', e.target.value.trim())} />
              </div>
            </div>
            <div className="field">
              <label htmlFor="srv-key">Private key</label>
              <div className="input-row">
                <input
                  id="srv-key"
                  className="input"
                  value={ssh.identityFile}
                  placeholder="Empty: use ssh-agent and your default keys"
                  onChange={(e) => setS('identityFile', e.target.value.trim())}
                />
                <button
                  className="btn"
                  onClick={async () => {
                    const picked = await api.pickFile([{ name: 'Private key', extensions: ['*'] }])
                    if (picked) setS('identityFile', picked)
                  }}
                >
                  <KeyRound size={14} /> Browse
                </button>
              </div>
              <div className="hint">Key authentication only; Openforge never asks for or stores a password. A key with a passphrase should be loaded into ssh-agent.</div>
            </div>
            <div className="row" style={{ gap: 8, marginBottom: 16 }}>
              <button
                className="btn"
                disabled={testing || !ssh.host || !ssh.user}
                onClick={async () => {
                  setTesting(true)
                  setTest(null)
                  try {
                    setTest(await api.testSshConnection(ssh))
                  } catch (e) {
                    setTest({ ok: false, kind: 'other', message: cleanError(e) })
                  } finally {
                    setTesting(false)
                  }
                }}
              >
                {testing ? <Loader2 size={14} className="spin" /> : <Wifi size={14} />} Test connection
              </button>
              {test && (
                <span className={`test-result ${test.ok ? 'ok' : 'bad'}`} role="status">
                  {test.ok ? '' : <TriangleAlert size={13} />} {test.message}
                </span>
              )}
            </div>

            <div className="field">
              <label>Runs in</label>
              <div className="segmented">
                {(['tmux', 'screen', 'systemd'] as SshControl[]).map((c) => (
                  <button key={c} className={ssh.control === c ? 'active' : ''} onClick={() => setS('control', c)}>
                    {c}
                  </button>
                ))}
              </div>
            </div>
            <div className="row" style={{ gap: 12 }}>
              {ssh.control === 'systemd' ? (
                <div className="field" style={{ flex: 1 }}>
                  <label htmlFor="srv-unit">Unit</label>
                  <input id="srv-unit" className="input" value={ssh.unit} onChange={(e) => setS('unit', e.target.value)} />
                </div>
              ) : (
                <div className="field" style={{ flex: 1 }}>
                  <label htmlFor="srv-session">Session name</label>
                  <input id="srv-session" className="input" value={ssh.session} onChange={(e) => setS('session', e.target.value)} />
                </div>
              )}
              <div className="field" style={{ flex: 2 }}>
                <label htmlFor="srv-rdir">Server folder</label>
                <input id="srv-rdir" className="input" value={ssh.serverDir} onChange={(e) => setS('serverDir', e.target.value)} />
              </div>
            </div>
            <div className="row" style={{ gap: 12 }}>
              {ssh.control !== 'systemd' && (
                <div className="field" style={{ flex: 1 }}>
                  <label htmlFor="srv-script">Start script</label>
                  <input id="srv-script" className="input" value={ssh.startScript} onChange={(e) => setS('startScript', e.target.value)} />
                </div>
              )}
              <div className="field" style={{ flex: 1 }}>
                <label htmlFor="srv-log">Log file</label>
                <input
                  id="srv-log"
                  className="input"
                  value={ssh.logPath}
                  placeholder={ssh.control === 'systemd' ? 'Empty: journalctl' : 'logs/latest.log'}
                  onChange={(e) => setS('logPath', e.target.value)}
                />
              </div>
            </div>

            <div className={`advanced${showCommands ? ' open' : ''}`}>
              <button className="advanced-toggle" aria-expanded={showCommands} onClick={() => setShowCommands((o) => !o)}>
                <Pencil size={14} className="advanced-chevron" />
                <span>
                  <strong>Commands</strong>
                  <small>Leave empty to use the {ssh.control} defaults shown. Your own commands run exactly as written.</small>
                </span>
              </button>
              {showCommands && preview && (
                <div className="advanced-body">
                  {(
                    [
                      ['startCommand', 'Start', preview.start],
                      ['stopCommand', 'Stop', preview.stop],
                      ['statusCommand', 'Status (exit 0 = running)', preview.status],
                      ['sendCommand', 'Send a console command ({cmd} = the command, quoted)', preview.send],
                      ['tailCommand', 'Stream the log', preview.tail]
                    ] as [keyof typeof ssh, string, string][]
                  ).map(([key, label, placeholder]) => (
                    <div className="field" key={key}>
                      <label>{label}</label>
                      <input
                        className="input mono"
                        value={String(ssh[key])}
                        placeholder={placeholder}
                        onChange={(e) => setS(key, e.target.value as never)}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}

        <div className="row" style={{ gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={saving || (kind !== 'ssh' && !dir) || (kind === 'create' && !eula)} onClick={save}>
            {saving ? <Loader2 size={15} className="spin" /> : null}
            {kind === 'create' ? 'Download and add' : initial ? 'Save' : 'Add server'}
          </button>
        </div>
      </div>
    </div>
  )
}
