import { useEffect, useRef, useState } from 'react'
import { Download, Loader2, Search, Wifi } from 'lucide-react'
import type { RemoteSshTarget } from '@shared/ipc'
import type { ContentProject, ContentVersion, RemoteHostInfo, ServerConfig, ServerDeploymentProgress } from '@shared/types'
import { api } from '../api'
import { useStore } from '../store/store'
import { cleanError } from '../util'

export function RemoteServerSetup({ target, name, onNameChange, onSaved, onBusyChange }: {
  target: RemoteSshTarget
  name: string
  onNameChange: (name: string) => void
  onSaved: (server: ServerConfig) => void
  onBusyChange: (busy: boolean) => void
}): JSX.Element {
  const toast = useStore((s) => s.toast)
  const versions = useStore((s) => s.versions)
  const latest = useStore((s) => s.latest)
  const [source, setSource] = useState<'vanilla' | 'modrinth' | 'curseforge'>('vanilla')
  const [mcVersion, setMcVersion] = useState(latest.release)
  const [slug, setSlug] = useState('')
  const [ramMb, setRamMb] = useState(4096)
  const [gamePort, setGamePort] = useState(25565)
  const [eula, setEula] = useState(false)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<ContentProject[]>([])
  const [project, setProject] = useState<ContentProject | null>(null)
  const [packVersions, setPackVersions] = useState<ContentVersion[]>([])
  const [versionId, setVersionId] = useState('')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [host, setHost] = useState<RemoteHostInfo | null>(null)
  const [progress, setProgress] = useState<ServerDeploymentProgress[]>([])
  const requestId = useRef('')
  const searchGeneration = useRef(0)
  const canConnect = Boolean(target.host && target.user)

  useEffect(() => api.onServerDeployment((event) => {
    if (event.requestId === requestId.current) setProgress((previous) => [...previous.slice(-19), event])
  }), [])

  useEffect(() => {
    setHost(null)
  }, [target.host, target.port, target.user, target.identityFile])

  useEffect(() => {
    if (!mcVersion && latest.release) setMcVersion(latest.release)
  }, [latest.release, mcVersion])

  async function search(): Promise<void> {
    if (source === 'vanilla') return
    const generation = ++searchGeneration.current
    setLoading(true)
    try {
      const result = await api.searchContent({ provider: source, kind: 'modpack', query, pageSize: 12 })
      if (generation === searchGeneration.current) setHits(result.hits)
    } catch (error) { toast(cleanError(error), 'error') }
    finally { if (generation === searchGeneration.current) setLoading(false) }
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
      const candidates = result.filter((entry) => !entry.isServerPack && (value.provider !== 'curseforge' || entry.serverPackFileId))
      setPackVersions(candidates)
      setVersionId(candidates[0]?.id ?? '')
    } catch (error) { toast(cleanError(error), 'error') }
    finally { if (generation === searchGeneration.current) setLoading(false) }
  }

  async function scan(): Promise<void> {
    setScanning(true)
    onBusyChange(true)
    try { setHost(await api.inspectRemoteHost(target)) }
    catch (error) { toast(cleanError(error), 'error') }
    finally { setScanning(false); onBusyChange(false) }
  }

  async function deploy(): Promise<void> {
    setBusy(true)
    onBusyChange(true)
    setProgress([])
    requestId.current = crypto.randomUUID()
    try {
      const server = await api.deployRemoteServer({
        requestId: requestId.current, target, name, slug: slug || suggestedSlug, source,
        mcVersion: source === 'vanilla' ? mcVersion : undefined,
        projectId: project?.id, versionId, ramMb, gamePort, acceptEula: eula
      })
      toast(server.name + ' is installed. Press Start.', 'success')
      onSaved(server)
    } catch (error) { toast(cleanError(error), 'error') }
    finally { setBusy(false); onBusyChange(false) }
  }

  const suggestedSlug = name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'minecraft'

  return (
    <div className="remote-setup">
      <div className="between" style={{ marginBottom: 12 }}>
        <p className="hint">Set up servers in ~/minecraft-servers using your SSH key.</p>
        <button className="btn sm" disabled={!canConnect || scanning || busy} onClick={scan}>
          {scanning ? <Loader2 size={14} className="spin" /> : <Wifi size={14} />} Scan host
        </button>
      </div>
      {host && (
        <div className="remote-host-info" role="status">
          <p>Python {host.pythonVersion} · {host.tmux ? 'tmux ready' : 'tmux needs installing'} · {(host.freeDiskMb / 1024).toFixed(1)} GB free</p>
          {!host.tmux && <p className="hint">Install tmux on the server before deploying. Java is installed automatically when needed.</p>}
          {host.servers.length === 0 ? <p className="hint">No server folders found yet.</p> : host.servers.map((server) => (
            <div className="between" key={server.slug}>
              <span>{server.name} <small className="muted">{server.directory}</small></span>
              {server.deployment ? (
                <button className="btn sm" disabled={busy} onClick={async () => {
                  setBusy(true)
                  onBusyChange(true)
                  try { onSaved(await api.importRemoteServer(target, server.slug)) }
                  catch (error) { toast(cleanError(error), 'error') }
                  finally { setBusy(false); onBusyChange(false) }
                }}>Add to OpenForge</button>
              ) : <small className="muted">Use “Existing server” to connect</small>}
            </div>
          ))}
        </div>
      )}
      <fieldset disabled={busy} className="remote-setup-fields">
        <div className="field">
          <label htmlFor="remote-source">Server source</label>
          <select id="remote-source" className="select" value={source} onChange={(event) => {
            searchGeneration.current++
            setSource(event.target.value as typeof source)
            setProject(null); setHits([]); setPackVersions([]); setVersionId(''); setLoading(false)
          }}>
            <option value="vanilla">Vanilla</option>
            <option value="modrinth">Modrinth modpack</option>
            <option value="curseforge">CurseForge server pack</option>
          </select>
        </div>
        {source === 'vanilla' ? (
          <div className="field">
            <label htmlFor="remote-version">Minecraft version</label>
            <select id="remote-version" className="select" value={mcVersion} onChange={(event) => setMcVersion(event.target.value)}>
              {versions.filter((entry) => entry.type === 'release').map((entry) => <option key={entry.id} value={entry.id}>{entry.id}</option>)}
            </select>
          </div>
        ) : (
          <>
            <div className="field">
              <label htmlFor="remote-query">Find a modpack</label>
              <div className="input-row">
                <input id="remote-query" className="input" value={query} placeholder="Search modpacks" onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void search() } }} />
                <button className="btn" disabled={loading} onClick={search}>{loading ? <Loader2 size={14} className="spin" /> : <Search size={14} />} Search</button>
              </div>
              {source === 'curseforge' && <p className="hint">Uses the CurseForge credentials in Settings. Only releases with a linked server pack are offered.</p>}
              {source === 'modrinth' && <p className="hint">Installs required server files and server overrides from the pack.</p>}
            </div>
            {hits.length > 0 && (
              <div className="remote-pack-results">
                {hits.map((hit) => <button className={'btn remote-pack-result' + (project?.id === hit.id ? ' active' : '')} key={hit.id} onClick={() => selectProject(hit)}>
                  <strong>{hit.name}</strong><small>{hit.summary}</small>
                </button>)}
              </div>
            )}
            {project && (
              <div className="field">
                <label htmlFor="remote-pack-version">{project.name} version</label>
                <select id="remote-pack-version" className="select" value={versionId} onChange={(event) => setVersionId(event.target.value)}>
                  {!packVersions.length && <option value="">{loading ? 'Loading versions…' : 'No supported server release found'}</option>}
                  {packVersions.map((entry) => <option key={entry.id} value={entry.id}>{entry.name} · Minecraft {entry.gameVersions.join(', ')}</option>)}
                </select>
              </div>
            )}
          </>
        )}
        <div className="field">
          <label htmlFor="remote-slug">Server folder name</label>
          <input id="remote-slug" className="input mono" value={slug} placeholder={suggestedSlug} maxLength={64} onChange={(event) => setSlug(event.target.value)} />
          <p className="hint">~/minecraft-servers/{slug || suggestedSlug}</p>
        </div>
        <div className="row" style={{ gap: 12 }}>
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="remote-ram">Server memory (MB)</label>
            <input id="remote-ram" className="input" type="number" min={512} max={262144} step={256} value={ramMb} onChange={(event) => setRamMb(Number(event.target.value))} />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="remote-game-port">Minecraft port</label>
            <input id="remote-game-port" className="input" type="number" min={1} max={65535} value={gamePort} onChange={(event) => setGamePort(Number(event.target.value))} />
          </div>
        </div>
        <label className="check-row" style={{ marginBottom: 16 }}>
          <input type="checkbox" checked={eula} onChange={(event) => setEula(event.target.checked)} /> I accept the{' '}
          <button className="link-button" type="button" onClick={() => api.openExternal('https://aka.ms/MinecraftEULA')}>Minecraft EULA</button>
        </label>
      </fieldset>
      {progress.length > 0 && <div className="remote-deploy-progress" role="log" aria-live="polite">
        {progress.map((event, index) => <p key={index} className={event.phase === 'error' ? 'error' : ''}>{event.message}</p>)}
      </div>}
      <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
        {busy && requestId.current && <button className="btn" onClick={() => api.cancelServerDeployment(requestId.current).catch((error) => toast(cleanError(error), 'error'))}>Cancel setup</button>}
        <button className="btn primary" disabled={busy || scanning || !canConnect || !name.trim() || !eula || (source !== 'vanilla' && !versionId) || (source === 'vanilla' && !mcVersion)} onClick={deploy}>
          {busy ? <Loader2 size={15} className="spin" /> : <Download size={15} />} {busy ? 'Setting up…' : 'Set up server'}
        </button>
      </div>
    </div>
  )
}
