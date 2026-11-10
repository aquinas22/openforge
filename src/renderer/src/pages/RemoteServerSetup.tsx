import { useEffect, useRef, useState } from 'react'
import { Check, CircleStop, Download, Loader2, Package, Search, TriangleAlert, Wifi, X } from 'lucide-react'
import type { RemoteSshTarget } from '@shared/ipc'
import type { ContentProject, ContentVersion, RemoteHostInfo, ServerConfig, ServerDeploymentProgress } from '@shared/types'
import { api } from '../api'
import { useStore } from '../store/store'
import { cleanError, compact } from '../util'

type Source = 'vanilla' | 'modrinth' | 'curseforge'
type Phase = ServerDeploymentProgress['phase']

const SOURCES: [Source, string][] = [
  ['vanilla', 'Vanilla'],
  ['modrinth', 'Modrinth pack'],
  ['curseforge', 'CurseForge pack']
]

/** The steps the deployment reports, in the order they happen on the host. */
const STEPS: { label: string; phases: Phase[] }[] = [
  { label: 'Prepare', phases: ['resolving'] },
  { label: 'Upload', phases: ['uploading'] },
  { label: 'Download', phases: ['downloading'] },
  { label: 'Extract', phases: ['extracting'] },
  { label: 'Java', phases: ['java'] },
  { label: 'Loader', phases: ['loader'] },
  { label: 'Ready', phases: ['ready'] }
]

const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/
const LOW_DISK_MB = 4096

/** Folder names allow lowercase letters, digits, dashes and underscores; tidy anything else as it is typed. */
function toSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/-{2,}/g, '-').slice(0, 64)
}

export function RemoteServerSetup({ target, name, onNameChange, onSaved, onBusyChange, onClose }: {
  target: RemoteSshTarget
  name: string
  onNameChange: (name: string) => void
  onSaved: (server: ServerConfig) => void
  onBusyChange: (busy: boolean) => void
  onClose: () => void
}): JSX.Element {
  const toast = useStore((s) => s.toast)
  const versions = useStore((s) => s.versions)
  const latest = useStore((s) => s.latest)
  const [source, setSource] = useState<Source>('vanilla')
  const [mcVersion, setMcVersion] = useState(latest.release)
  const [slug, setSlug] = useState('')
  const [ramGb, setRamGb] = useState(4)
  const [gamePort, setGamePort] = useState(25565)
  const [eula, setEula] = useState(false)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<ContentProject[]>([])
  const [searched, setSearched] = useState(false)
  const [project, setProject] = useState<ContentProject | null>(null)
  const [packVersions, setPackVersions] = useState<ContentVersion[]>([])
  const [versionId, setVersionId] = useState('')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [scanError, setScanError] = useState('')
  const [host, setHost] = useState<RemoteHostInfo | null>(null)
  const [progress, setProgress] = useState<ServerDeploymentProgress[]>([])
  const [failure, setFailure] = useState('')
  const requestId = useRef('')
  const cancelled = useRef(false)
  const searchGeneration = useRef(0)
  const canConnect = Boolean(target.host && target.user)

  const suggestedSlug = toSlug(name.trim() || project?.slug || '').replace(/^[-_]+|[-_]+$/g, '') || 'minecraft'
  const folder = slug || suggestedSlug
  const slugValid = SLUG_PATTERN.test(folder)
  const slugTaken = Boolean(host?.servers.some((entry) => entry.slug === folder))
  const ramMb = Math.round(ramGb * 1024)
  const ramValid = Number.isFinite(ramGb) && ramMb >= 512 && ramMb <= 262144
  const portValid = Number.isInteger(gamePort) && gamePort >= 1 && gamePort <= 65535
  const releases = versions.filter((entry) => entry.type === 'release')
  const ready = canConnect && name.trim() && eula && slugValid && !slugTaken && ramValid && portValid &&
    (source === 'vanilla' ? Boolean(mcVersion) : Boolean(versionId))

  useEffect(() => api.onServerDeployment((event) => {
    if (event.requestId === requestId.current) setProgress((previous) => [...previous.slice(-49), event])
  }), [])

  // A different host or user makes the last scan meaningless.
  useEffect(() => {
    setHost(null)
    setScanError('')
  }, [target.host, target.port, target.user, target.identityFile])

  useEffect(() => {
    if (!mcVersion && latest.release) setMcVersion(latest.release)
  }, [latest.release, mcVersion])

  // Search as the query changes (popular packs when it is empty), a moment after typing stops.
  useEffect(() => {
    if (source === 'vanilla' || project) return
    const generation = ++searchGeneration.current
    const timer = window.setTimeout(async () => {
      setLoading(true)
      try {
        const result = await api.searchContent({ provider: source, kind: 'modpack', query: query.trim(), pageSize: 12 })
        if (generation === searchGeneration.current) setHits(result.hits)
      } catch (error) {
        if (generation === searchGeneration.current) { setHits([]); toast(cleanError(error), 'error') }
      } finally {
        if (generation === searchGeneration.current) { setLoading(false); setSearched(true) }
      }
    }, query ? 350 : 0)
    return () => window.clearTimeout(timer)
  }, [source, query, project, toast])

  function chooseSource(next: Source): void {
    if (next === source) return
    searchGeneration.current++
    setSource(next)
    setProject(null); setHits([]); setSearched(false); setQuery(''); setPackVersions([]); setVersionId(''); setLoading(false)
  }

  async function selectProject(value: ContentProject): Promise<void> {
    const generation = ++searchGeneration.current
    setProject(value)
    setPackVersions([])
    setVersionId('')
    setLoading(true)
    if (!name.trim()) onNameChange(value.name.slice(0, 60))
    try {
      const result = await api.getVersions(value.provider, value.id)
      if (generation !== searchGeneration.current) return
      // CurseForge client releases are only usable when they link a server pack.
      const candidates = result.filter((entry) => !entry.isServerPack && (value.provider !== 'curseforge' || entry.serverPackFileId))
      setPackVersions(candidates)
      setVersionId(candidates[0]?.id ?? '')
    } catch (error) { toast(cleanError(error), 'error') }
    finally { if (generation === searchGeneration.current) setLoading(false) }
  }

  function clearProject(): void {
    searchGeneration.current++
    setProject(null)
    setPackVersions([])
    setVersionId('')
    setLoading(false)
  }

  async function scan(): Promise<void> {
    setScanning(true)
    setScanError('')
    onBusyChange(true)
    try { setHost(await api.inspectRemoteHost(target)) }
    catch (error) { setHost(null); setScanError(cleanError(error)) }
    finally { setScanning(false); onBusyChange(false) }
  }

  async function importServer(serverSlug: string): Promise<void> {
    setBusy(true)
    onBusyChange(true)
    try { onSaved(await api.importRemoteServer(target, serverSlug)) }
    catch (error) { toast(cleanError(error), 'error') }
    finally { setBusy(false); onBusyChange(false) }
  }

  async function deploy(): Promise<void> {
    setBusy(true)
    onBusyChange(true)
    setProgress([])
    setFailure('')
    cancelled.current = false
    requestId.current = crypto.randomUUID()
    try {
      const server = await api.deployRemoteServer({
        requestId: requestId.current, target, name: name.trim(), slug: folder, source,
        mcVersion: source === 'vanilla' ? mcVersion : undefined,
        projectId: project?.id, versionId, ramMb, gamePort, acceptEula: eula
      })
      toast(`${server.name} is installed. Press Start when you are ready.`, 'success')
      onSaved(server)
    } catch (error) {
      if (cancelled.current) {
        setProgress([])
        toast('Setup cancelled. Nothing was left on the host.', 'info')
      } else {
        setFailure(cleanError(error))
      }
    } finally {
      setBusy(false)
      onBusyChange(false)
    }
  }

  function cancel(): void {
    cancelled.current = true
    api.cancelServerDeployment(requestId.current).catch((error) => toast(cleanError(error), 'error'))
  }

  const phase = progress.at(-1)?.phase
  const reached = Math.max(-1, ...progress.map((event) => STEPS.findIndex((step) => step.phases.includes(event.phase))))
  const showSteps = busy || progress.length > 0 || failure
  const lastMessage = [...progress].reverse().find((event) => event.phase !== 'error')?.message

  return (
    <div className="remote-setup">
      <div className="remote-host-check">
        <button className="btn" disabled={!canConnect || scanning || busy} onClick={scan}>
          {scanning ? <Loader2 size={14} className="spin" /> : <Wifi size={14} />} {host ? 'Check again' : 'Check host'}
        </button>
        {!host && !scanError && (
          <span className="hint" style={{ margin: 0 }}>
            {canConnect ? 'Connects over SSH and checks Python, tmux and free space. Nothing is changed.' : 'Enter a host and user first.'}
          </span>
        )}
        {scanError && <span className="test-result bad" role="status"><TriangleAlert size={13} /> {scanError}</span>}
      </div>

      {host && (
        <div className="remote-host-info" role="status">
          <ul className="remote-host-facts">
            <li className="ok"><Check size={13} /> Python {host.pythonVersion}</li>
            <li className={host.tmux ? 'ok' : 'bad'}>{host.tmux ? <Check size={13} /> : <X size={13} />} {host.tmux ? 'tmux' : 'tmux missing'}</li>
            <li className="ok"><Check size={13} /> {host.javaVersion ? `Java ${host.javaVersion}` : 'Java installed per server'}</li>
            <li className={host.freeDiskMb < LOW_DISK_MB ? 'warn' : 'ok'}>
              {host.freeDiskMb < LOW_DISK_MB ? <TriangleAlert size={13} /> : <Check size={13} />} {(host.freeDiskMb / 1024).toFixed(1)} GB free
            </li>
          </ul>
          {!host.tmux && <p className="hint">Install tmux on the host first, for example <code>sudo apt install tmux</code>.</p>}
          {host.freeDiskMb < LOW_DISK_MB && <p className="hint">Modpack servers often need several GB. Free up space before setting one up.</p>}
          {host.servers.length > 0 && (
            <div className="remote-host-servers">
              <small className="eyebrow">Already in {host.root}</small>
              {host.servers.map((server) => (
                <div className="between" key={server.slug}>
                  <span className="remote-host-server">
                    <strong>{server.name}</strong>
                    <small className="muted">{server.slug}</small>
                  </span>
                  {server.deployment ? (
                    <button className="btn sm" disabled={busy} onClick={() => importServer(server.slug)}>Add to OpenForge</button>
                  ) : <small className="muted">Not set up by OpenForge. Use “Connect an existing one”.</small>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <fieldset disabled={busy} className="remote-setup-fields">
        <div className="field">
          <label>What to run</label>
          <div className="segmented" role="radiogroup" aria-label="Server source">
            {SOURCES.map(([key, label]) => (
              <button key={key} type="button" role="radio" aria-checked={source === key} className={source === key ? 'active' : ''} onClick={() => chooseSource(key)}>
                {label}
              </button>
            ))}
          </div>
        </div>

        {source === 'vanilla' ? (
          <div className="field">
            <label htmlFor="remote-version">Minecraft version</label>
            <select id="remote-version" className="select" value={mcVersion} disabled={!releases.length} onChange={(event) => setMcVersion(event.target.value)}>
              {!releases.length && <option value="">Version list unavailable. Check your connection.</option>}
              {releases.map((entry) => <option key={entry.id} value={entry.id}>{entry.id}{entry.id === latest.release ? ' (latest)' : ''}</option>)}
            </select>
            <p className="hint">Mojang&apos;s official server, checked against its published hash.</p>
          </div>
        ) : project ? (
          <>
            <div className="field">
              <label>Modpack</label>
              <div className="remote-pack-result active static">
                <PackIcon project={project} />
                <span className="remote-pack-copy">
                  <strong>{project.name}</strong>
                  <small>{project.authors[0] ? `by ${project.authors[0]} · ` : ''}{compact(project.downloads)} downloads</small>
                </span>
                <button className="btn sm ghost" type="button" onClick={clearProject}>Change</button>
              </div>
            </div>
            <div className="field">
              <label htmlFor="remote-pack-version">Pack version</label>
              <select id="remote-pack-version" className="select" value={versionId} disabled={!packVersions.length} onChange={(event) => setVersionId(event.target.value)}>
                {!packVersions.length && (
                  <option value="">{loading ? 'Loading versions…' : source === 'curseforge' ? 'No release with a server pack' : 'No versions found'}</option>
                )}
                {packVersions.map((entry) => <option key={entry.id} value={entry.id}>{entry.name} · Minecraft {entry.gameVersions.join(', ')}</option>)}
              </select>
              <p className="hint">
                {source === 'curseforge'
                  ? 'Only releases that link a server pack are listed. Uses the CurseForge key from Settings.'
                  : 'Installs the files the pack marks for servers, plus its server overrides. Client-only mods are left out.'}
              </p>
            </div>
          </>
        ) : (
          <div className="field">
            <label htmlFor="remote-query">Modpack</label>
            <div className="add-panel-search">
              {loading ? <Loader2 size={16} className="spin" /> : <Search size={16} />}
              <input
                id="remote-query"
                className="input"
                value={query}
                placeholder={`Search ${source === 'modrinth' ? 'Modrinth' : 'CurseForge'} modpacks`}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter') event.preventDefault() }}
              />
            </div>
            <div className="remote-pack-results" aria-busy={loading}>
              {hits.map((hit) => (
                <button type="button" className="remote-pack-result" key={hit.id} onClick={() => selectProject(hit)}>
                  <PackIcon project={hit} />
                  <span className="remote-pack-copy">
                    <strong>{hit.name}</strong>
                    <small>{hit.summary}</small>
                  </span>
                  <small className="muted remote-pack-downloads"><Download size={11} /> {compact(hit.downloads)}</small>
                </button>
              ))}
              {searched && !loading && hits.length === 0 && <p className="hint" style={{ margin: 0 }}>No modpacks match “{query}”.</p>}
            </div>
          </div>
        )}

        <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
          <div className="field" style={{ flex: 2 }}>
            <label htmlFor="remote-slug">Folder on the host</label>
            <input
              id="remote-slug"
              className="input mono"
              value={slug}
              placeholder={suggestedSlug}
              maxLength={64}
              aria-invalid={!slugValid || slugTaken}
              onChange={(event) => setSlug(toSlug(event.target.value))}
              onBlur={() => setSlug((value) => value.replace(/[-_]+$/, ''))}
            />
            <p className={`hint${!slugValid || slugTaken ? ' danger' : ''}`}>
              {slugTaken ? 'That folder already exists on the host. Pick another name, or add it from the list above.'
                : !slugValid ? 'Start with a letter or digit.'
                : `~/minecraft-servers/${folder}`}
            </p>
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="remote-ram">Memory (GB)</label>
            <input id="remote-ram" className="input" type="number" min={1} max={256} step={0.5} value={ramGb} aria-invalid={!ramValid} onChange={(event) => setRamGb(event.target.valueAsNumber)} />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="remote-game-port">Game port</label>
            <input id="remote-game-port" className="input" type="number" min={1} max={65535} value={Number.isNaN(gamePort) ? '' : gamePort} aria-invalid={!portValid} onChange={(event) => setGamePort(event.target.valueAsNumber)} />
          </div>
        </div>
        <p className="hint" style={{ marginTop: -8, marginBottom: 14 }}>
          Players connect on the game port; allow it through the host&apos;s firewall if they join from outside.
        </p>

        <label className="check-row" style={{ marginBottom: 16 }}>
          <input type="checkbox" checked={eula} onChange={(event) => setEula(event.target.checked)} /> I accept the{' '}
          <button className="link-button" type="button" onClick={() => api.openExternal('https://aka.ms/MinecraftEULA')}>Minecraft EULA</button>
        </label>
      </fieldset>

      {showSteps && (
        <div className="remote-deploy" role="status" aria-live="polite">
          <ol className="launch-steps" aria-label="Setup progress">
            {STEPS.filter((step) => source !== 'vanilla' || !step.phases.includes('loader')).map((step) => {
              const index = STEPS.indexOf(step)
              const state = failure && index === Math.max(reached, 0) ? 'failed'
                : phase === 'ready' || index < reached ? 'done'
                : index === reached ? 'current' : 'todo'
              return (
                <li key={step.label} className={state} aria-current={state === 'current' ? 'step' : undefined}>
                  <i>{state === 'done' ? <Check size={10} strokeWidth={3} /> : state === 'failed' ? <X size={10} strokeWidth={3} /> : null}</i>
                  <span>{step.label}</span>
                </li>
              )
            })}
          </ol>
          {failure ? (
            <div className="notice danger" style={{ margin: '12px 0 0' }}>
              <TriangleAlert size={16} />
              <div>
                <strong>Setup did not finish</strong>
                <span>{failure}</span>
                <span>Nothing was published on the host, so you can fix the problem and try again.</span>
              </div>
            </div>
          ) : (
            <p className="remote-deploy-message">{busy && <Loader2 size={13} className="spin" />} {lastMessage ?? 'Connecting…'}</p>
          )}
        </div>
      )}

      <div className="row" style={{ gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
        {busy && requestId.current ? (
          <button className="btn" onClick={cancel}><CircleStop size={15} /> Cancel setup</button>
        ) : (
          <button className="btn ghost" disabled={busy || scanning} onClick={onClose}>Cancel</button>
        )}
        <button className="btn primary" disabled={busy || scanning || !ready} onClick={deploy}>
          {busy ? <Loader2 size={15} className="spin" /> : <Download size={15} />} {busy ? 'Setting up…' : failure ? 'Try again' : 'Set up server'}
        </button>
      </div>
    </div>
  )
}

function PackIcon({ project }: { project: ContentProject }): JSX.Element {
  const [broken, setBroken] = useState(false)
  return project.iconUrl && !broken
    ? <img className="remote-pack-icon" src={project.iconUrl} alt="" loading="lazy" onError={() => setBroken(true)} />
    : <span className="remote-pack-icon"><Package size={16} /></span>
}
