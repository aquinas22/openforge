import { ipcMain, type BrowserWindow } from 'electron'
import AdmZip from 'adm-zip'
import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { IPC, type CreateLocalServerInput } from '@shared/ipc'
import type {
  LocalServerConfig,
  ServerConfig,
  ServerFolderInfo,
  ServerLogLine,
  ServerStatus,
  SshServerConfig,
  SshTestResult
} from '@shared/types'
import {
  buildSshArgs,
  classifySshError,
  effectiveCommands,
  validateRemoteName,
  validateSshTarget,
  type SshTarget
} from '@shared/ssh'
import { loadServers, saveServers } from './core/store'
import { buildLocalLaunch, startServerProcess, type ServerProcess } from './core/servers/process'
import { PlayerTracker } from './core/servers/logparse'
import { runSsh, streamSsh } from './core/servers/sshrun'
import { fetchVersionDetail, fetchVersionManifest } from './core/manifest'
import { downloadFile } from './core/http'

/**
 * The Servers section: local servers run as child processes, SSH servers are
 * driven through the system ssh client. Configs persist in servers.json in the
 * data folder; status and console output stream to the renderer.
 */

const MAX_LOG = 1500
const SSH_TIMEOUT_MS = 30_000

interface Deps {
  getWindow: () => BrowserWindow | null
  /** A Java for this major version (managed download if needed), or null. */
  resolveJava: (major: number) => Promise<string | null>
  maxRamMb: number
}

export function registerServerIpc(deps: Deps): { shutdown: () => Promise<void> } {
  let configs: ServerConfig[] = loadServers()
  const status = new Map<string, ServerStatus>()
  const logs = new Map<string, ServerLogLine[]>()
  const trackers = new Map<string, PlayerTracker>()
  const local = new Map<string, ServerProcess>()
  const tails = new Map<string, { stop: () => void }>()

  const send = (channel: string, payload: unknown): void => deps.getWindow()?.webContents.send(channel, payload)
  const persist = (): void => saveServers(configs)
  const find = (id: string): ServerConfig => {
    const cfg = configs.find((c) => c.id === String(id))
    if (!cfg) throw new Error('Server not found.')
    return cfg
  }
  const tracker = (id: string): PlayerTracker => {
    let t = trackers.get(id)
    if (!t) trackers.set(id, (t = new PlayerTracker()))
    return t
  }
  const statusOf = (id: string): ServerStatus => status.get(id) ?? { id, state: find(id).kind === 'local' ? 'stopped' : 'unknown' }
  const setStatus = (id: string, patch: Partial<ServerStatus>): void => {
    const next = { ...statusOf(id), ...patch, id }
    status.set(id, next)
    send(IPC.serverStatusEvent, next)
  }
  const log = (id: string, stream: ServerLogLine['stream'], line: string): void => {
    const entry: ServerLogLine = { serverId: id, stream, line, ts: Date.now() }
    const list = logs.get(id) ?? []
    list.push(entry)
    if (list.length > MAX_LOG) list.splice(0, list.length - MAX_LOG)
    logs.set(id, list)
    send(IPC.serverLogEvent, entry)
    if (stream === 'stdout' || stream === 'stderr') {
      const t = tracker(id)
      const event = t.feed(line)
      if (!event) return
      const patch: Partial<ServerStatus> = { players: t.snapshot }
      if (event.type === 'done') patch.state = 'running'
      if (event.type === 'stopping' && statusOf(id).state === 'running') patch.state = 'stopping'
      setStatus(id, patch)
    }
  }
  const system = (id: string, line: string): void => log(id, 'system', `[Openforge] ${line}`)

  // -- Validation ----------------------------------------------------------------------
  const text = (value: unknown, max: number, what: string): string => {
    const s = String(value ?? '')
    if (s.length > max || s.includes('\0')) throw new Error(`The ${what} is too long.`)
    return s
  }

  function normalize(input: Partial<ServerConfig> & { kind: ServerConfig['kind'] }, existing?: ServerConfig): ServerConfig {
    const name = text(input.name, 60, 'name').trim()
    if (!name) throw new Error('Give the server a name.')
    const base = { id: existing?.id ?? randomUUID(), name, createdAt: existing?.createdAt ?? new Date().toISOString() }
    if (input.kind === 'local') {
      const i = input as Partial<LocalServerConfig>
      const dir = text(i.dir, 1000, 'folder').trim()
      if (!dir || !isAbsolute(dir) || !existsSync(dir) || !statSync(dir).isDirectory()) {
        throw new Error('Pick the server folder.')
      }
      const file = basename(text(i.file, 255, 'file name'))
      if (!file || !existsSync(join(dir, file))) throw new Error(`"${file || 'The start file'}" is not in that folder.`)
      const launch = i.launch === 'script' ? 'script' : 'jar'
      // Validates the launch shape for this platform.
      buildLocalLaunch({ launch, file, ramMb: 1024, jvmArgs: '' }, 'java')
      return {
        ...base,
        kind: 'local',
        dir,
        launch,
        file,
        javaPath: text(i.javaPath, 1000, 'Java path').trim(),
        ramMb: Math.min(deps.maxRamMb, Math.max(512, Math.round(Number(i.ramMb) || 2048))),
        jvmArgs: text(i.jvmArgs, 2000, 'JVM arguments'),
        stopTimeoutSec: Math.min(600, Math.max(5, Math.round(Number(i.stopTimeoutSec) || 45)))
      }
    }
    const i = input as Partial<SshServerConfig>
    const target: SshTarget = {
      host: text(i.host, 253, 'host').trim(),
      port: Number(i.port ?? 22),
      user: text(i.user, 32, 'user').trim(),
      identityFile: text(i.identityFile, 1000, 'key file').trim()
    }
    validateSshTarget(target)
    if (target.identityFile && (!isAbsolute(target.identityFile) || !existsSync(target.identityFile))) {
      throw new Error('That key file does not exist. Leave it empty to use ssh-agent.')
    }
    const control = i.control === 'screen' || i.control === 'systemd' ? i.control : 'tmux'
    const session = text(i.session, 100, 'session name').trim() || 'mc'
    const unit = text(i.unit, 100, 'unit name').trim() || 'minecraft'
    if (control === 'systemd') validateRemoteName(unit, 'systemd unit name')
    else validateRemoteName(session, 'session name')
    return {
      ...base,
      kind: 'ssh',
      ...target,
      control,
      session,
      unit,
      serverDir: text(i.serverDir, 400, 'server folder').trim() || '~/server',
      startScript: text(i.startScript, 400, 'start script').trim() || './run.sh',
      logPath: text(i.logPath, 400, 'log path').trim(),
      startCommand: text(i.startCommand, 2000, 'start command'),
      stopCommand: text(i.stopCommand, 2000, 'stop command'),
      statusCommand: text(i.statusCommand, 2000, 'status command'),
      sendCommand: text(i.sendCommand, 2000, 'send command'),
      tailCommand: text(i.tailCommand, 2000, 'log command')
    }
  }

  // -- Local servers -------------------------------------------------------------------
  /** The Java major a server jar asks for, from the version.json inside it (1.14+). */
  async function javaMajorOfJar(path: string): Promise<number | null> {
    try {
      const entry = new AdmZip(path).getEntry('version.json')
      const json = entry ? (JSON.parse(entry.getData().toString('utf8')) as { java_version?: number }) : null
      return typeof json?.java_version === 'number' ? json.java_version : null
    } catch {
      return null
    }
  }

  async function startLocal(cfg: LocalServerConfig): Promise<void> {
    if (local.get(cfg.id)?.running) throw new Error('This server is already running.')
    let java = cfg.javaPath
    if (!java && cfg.launch === 'jar') {
      const major = await javaMajorOfJar(join(cfg.dir, cfg.file))
      java = (await deps.resolveJava(major ?? 21)) ?? 'java'
      system(cfg.id, `Using Java ${major ?? 'from PATH or managed'}: ${java}`)
    }
    const launch = buildLocalLaunch(cfg, java)
    tracker(cfg.id).reset()
    system(cfg.id, `Starting in ${cfg.dir}: ${launch.command} ${launch.args.join(' ')}`)
    const startedAt = Date.now()
    setStatus(cfg.id, { state: 'starting', startedAt, players: undefined, message: undefined })
    const proc = startServerProcess({
      ...launch,
      cwd: cfg.dir,
      onLine: (stream, line) => log(cfg.id, stream, line),
      onError: (err) => system(cfg.id, `Could not start: ${err.message}`),
      onExit: (code) => {
        local.delete(cfg.id)
        const wasStopping = statusOf(cfg.id).state === 'stopping'
        system(cfg.id, `Server exited with code ${code ?? 'unknown'}.`)
        setStatus(cfg.id, {
          state: code === 0 || wasStopping ? 'stopped' : 'error',
          message: code === 0 || wasStopping ? undefined : `Exited with code ${code}`,
          startedAt: undefined,
          players: undefined
        })
      }
    })
    local.set(cfg.id, proc)
  }

  async function stopLocal(cfg: LocalServerConfig): Promise<void> {
    const proc = local.get(cfg.id)
    if (!proc?.running) {
      setStatus(cfg.id, { state: 'stopped' })
      return
    }
    setStatus(cfg.id, { state: 'stopping' })
    log(cfg.id, 'input', '> stop')
    const result = await proc.stop(cfg.stopTimeoutSec * 1000)
    if (result === 'killed') system(cfg.id, `The server did not stop within ${cfg.stopTimeoutSec}s and was killed.`)
  }

  // -- SSH servers ------------------------------------------------------------------------
  async function ssh(cfg: SshServerConfig, command: string, what: string): Promise<{ code: number | null; stdout: string }> {
    const result = await runSsh(buildSshArgs(cfg, command), SSH_TIMEOUT_MS)
    for (const line of result.stdout.split(/\r?\n/).filter(Boolean).slice(-40)) log(cfg.id, 'stdout', line)
    if (result.code === 255 || result.code === -1 || result.timedOut) {
      const failure = classifySshError(result.stderr, result.code, result.timedOut)
      system(cfg.id, `${what} failed: ${failure.message}`)
      setStatus(cfg.id, { state: 'error', message: failure.message, checkedAt: Date.now() })
      throw new Error(failure.message)
    }
    for (const line of result.stderr.split(/\r?\n/).filter(Boolean).slice(-20)) log(cfg.id, 'stderr', line)
    return { code: result.code, stdout: result.stdout }
  }

  async function refreshSsh(cfg: SshServerConfig): Promise<ServerStatus> {
    const { code } = await ssh(cfg, effectiveCommands(cfg).status, 'Status check')
    const previous = statusOf(cfg.id)
    const running = code === 0
    setStatus(cfg.id, {
      state: running ? (previous.state === 'stopping' ? 'stopping' : 'running') : 'stopped',
      startedAt: running ? (previous.startedAt ?? Date.now()) : undefined,
      message: undefined,
      checkedAt: Date.now(),
      players: running ? previous.players : undefined
    })
    return statusOf(cfg.id)
  }

  function startTail(cfg: SshServerConfig): void {
    if (tails.has(cfg.id)) return
    const command = effectiveCommands(cfg).tail
    system(cfg.id, `Streaming the log: ${command}`)
    const handle = streamSsh(
      buildSshArgs(cfg, command, { connectTimeout: 10 }),
      (stream, line) => log(cfg.id, stream, line),
      (code, stderr) => {
        tails.delete(cfg.id)
        const failure = code === 255 || code === -1 ? classifySshError(stderr, code) : null
        system(cfg.id, failure ? `Log stream failed: ${failure.message}` : `Log stream ended (code ${code ?? 'none'}).`)
        setStatus(cfg.id, { tailing: false })
      }
    )
    tails.set(cfg.id, handle)
    setStatus(cfg.id, { tailing: true })
  }

  // -- IPC ------------------------------------------------------------------------------------
  ipcMain.handle(IPC.listServers, () => configs)
  ipcMain.handle(IPC.serverStatuses, () => configs.map((c) => statusOf(c.id)))
  ipcMain.handle(IPC.serverLog, (_e, id: string) => logs.get(String(id)) ?? [])

  ipcMain.handle(IPC.saveServer, (_e, input: Partial<ServerConfig> & { kind: ServerConfig['kind'] }) => {
    const existing = input.id ? configs.find((c) => c.id === input.id) : undefined
    if (existing && existing.kind !== input.kind) throw new Error('A server cannot change between local and SSH.')
    if (existing?.kind === 'local' && local.get(existing.id)?.running) {
      throw new Error('Stop the server before changing its settings.')
    }
    const cfg = normalize(input, existing)
    configs = existing ? configs.map((c) => (c.id === cfg.id ? cfg : c)) : [...configs, cfg]
    persist()
    return cfg
  })

  ipcMain.handle(IPC.deleteServer, async (_e, id: string) => {
    const cfg = find(id)
    if (cfg.kind === 'local' && local.get(cfg.id)?.running) throw new Error('Stop the server before removing it.')
    tails.get(cfg.id)?.stop()
    configs = configs.filter((c) => c.id !== cfg.id)
    status.delete(cfg.id)
    logs.delete(cfg.id)
    persist()
    // The server folder itself is never touched.
  })

  ipcMain.handle(IPC.startServer, async (_e, id: string) => {
    const cfg = find(id)
    if (cfg.kind === 'local') return startLocal(cfg)
    system(cfg.id, 'Starting…')
    const { code } = await ssh(cfg, effectiveCommands(cfg).start, 'Start')
    if (code !== 0) {
      setStatus(cfg.id, { state: 'error', message: `The start command exited with code ${code}.` })
      throw new Error(`The start command exited with code ${code}. The console shows its output.`)
    }
    tracker(cfg.id).reset()
    setStatus(cfg.id, { state: 'starting', startedAt: Date.now(), players: undefined })
    await refreshSsh(cfg).catch(() => undefined)
  })

  ipcMain.handle(IPC.stopServer, async (_e, id: string) => {
    const cfg = find(id)
    if (cfg.kind === 'local') return stopLocal(cfg)
    setStatus(cfg.id, { state: 'stopping' })
    log(cfg.id, 'input', '> stop')
    const { code } = await ssh(cfg, effectiveCommands(cfg).stop, 'Stop')
    if (code !== 0) system(cfg.id, `The stop command exited with code ${code}.`)
    // Give the server time to save and exit, then look again.
    void (async () => {
      for (let i = 0; i < 15; i++) {
        await new Promise((r) => setTimeout(r, 3000))
        try {
          if ((await refreshSsh(cfg)).state === 'stopped') return
        } catch {
          return
        }
      }
      system(cfg.id, 'Still running after 45s; check the console.')
    })()
  })

  ipcMain.handle(IPC.killServer, (_e, id: string) => {
    const cfg = find(id)
    if (cfg.kind !== 'local') throw new Error('Only local servers can be killed from here.')
    system(cfg.id, 'Killing the server process.')
    local.get(cfg.id)?.kill()
  })

  ipcMain.handle(IPC.sendServerCommand, async (_e, id: string, command: string) => {
    const cfg = find(id)
    const line = String(command ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 1000)
    if (!line) return
    if (cfg.kind === 'local') {
      const proc = local.get(cfg.id)
      if (!proc?.running) throw new Error('The server is not running.')
      log(cfg.id, 'input', `> ${line}`)
      proc.send(line)
      return
    }
    const remote = effectiveCommands(cfg).send(line)
    if (!remote) {
      throw new Error('A systemd server has no console to type into. Set a custom send command (for example with mcrcon).')
    }
    log(cfg.id, 'input', `> ${line}`)
    const { code } = await ssh(cfg, remote, 'Send')
    if (code !== 0) throw new Error(`The send command exited with code ${code}. Is the server session running?`)
  })

  ipcMain.handle(IPC.refreshServer, async (_e, id: string) => {
    const cfg = find(id)
    return cfg.kind === 'ssh' ? refreshSsh(cfg) : statusOf(cfg.id)
  })

  ipcMain.handle(IPC.tailServerLog, (_e, id: string, on: boolean) => {
    const cfg = find(id)
    if (cfg.kind !== 'ssh') return
    if (on) startTail(cfg)
    else tails.get(cfg.id)?.stop()
  })

  ipcMain.handle(IPC.testSshConnection, async (_e, input: Partial<SshServerConfig>): Promise<SshTestResult> => {
    const target: SshTarget = {
      host: String(input.host ?? '').trim(),
      port: Number(input.port ?? 22),
      user: String(input.user ?? '').trim(),
      identityFile: String(input.identityFile ?? '').trim()
    }
    try {
      validateSshTarget(target)
    } catch (err) {
      return { ok: false, kind: 'other', message: (err as Error).message }
    }
    if (target.identityFile && !existsSync(target.identityFile)) {
      return { ok: false, kind: 'key', message: 'That key file does not exist.' }
    }
    const result = await runSsh(buildSshArgs(target, 'echo openforge-ok', { connectTimeout: 8 }), 20_000)
    if (result.code === 0 && result.stdout.includes('openforge-ok')) {
      return { ok: true, kind: 'ok', message: `Connected to ${target.user}@${target.host}.` }
    }
    const failure = classifySshError(result.stderr, result.code, result.timedOut)
    return { ok: false, kind: failure.kind, message: failure.message }
  })

  ipcMain.handle(IPC.inspectServerFolder, async (_e, dir: string): Promise<ServerFolderInfo> => {
    const path = String(dir ?? '')
    if (!path || !isAbsolute(path) || !existsSync(path)) return { exists: false, jars: [], scripts: [], eulaAccepted: false }
    const names = await readdir(path).catch(() => [] as string[])
    const eula = await readFile(join(path, 'eula.txt'), 'utf8').catch(() => '')
    return {
      exists: true,
      jars: names.filter((n) => /\.jar$/i.test(n)).sort((a, b) => Number(/server/i.test(b)) - Number(/server/i.test(a))),
      scripts: names.filter((n) => /^[\w.-]+\.(bat|cmd|ps1|sh)$/i.test(n)),
      eulaAccepted: /^\s*eula\s*=\s*true\s*$/im.test(eula)
    }
  })

  ipcMain.handle(IPC.setServerEula, async (_e, id: string) => {
    const cfg = find(id)
    if (cfg.kind !== 'local') return
    await writeFile(join(cfg.dir, 'eula.txt'), `# Accepted in Openforge on ${new Date().toISOString()}\n# https://aka.ms/MinecraftEULA\neula=true\n`, 'utf8')
    system(cfg.id, 'EULA accepted (eula.txt).')
  })

  // A new vanilla server from Mojang's own server jar.
  ipcMain.handle(IPC.createLocalServer, async (_e, input: CreateLocalServerInput) => {
    const dir = String(input.dir ?? '').trim()
    if (!dir || !isAbsolute(dir)) throw new Error('Pick a folder for the new server.')
    const mcVersion = String(input.mcVersion ?? '').trim()
    const manifest = await fetchVersionManifest()
    const summary = manifest.versions.find((v) => v.id === mcVersion)
    if (!summary) throw new Error(`Minecraft ${mcVersion} was not found.`)
    const detail = await fetchVersionDetail(summary.url)
    const server = detail.downloads?.server
    if (!server) throw new Error(`Mojang publishes no server jar for ${mcVersion}.`)
    await mkdir(dir, { recursive: true })
    await downloadFile({ url: server.url, dest: join(dir, 'server.jar'), sha1: server.sha1, size: server.size })
    if (input.acceptEula) {
      await writeFile(join(dir, 'eula.txt'), `# Accepted in Openforge on ${new Date().toISOString()}\n# https://aka.ms/MinecraftEULA\neula=true\n`, 'utf8')
    }
    const cfg = normalize({
      kind: 'local',
      name: String(input.name ?? '').trim() || `Minecraft ${mcVersion}`,
      dir,
      launch: 'jar',
      file: 'server.jar',
      javaPath: '',
      ramMb: Number(input.ramMb) || 2048,
      jvmArgs: '',
      stopTimeoutSec: 45
    })
    configs = [...configs, cfg]
    persist()
    return cfg
  })

  return {
    /** On quit: stop local servers gracefully (bounded), end log streams. */
    async shutdown() {
      for (const handle of tails.values()) handle.stop()
      await Promise.all(
        configs
          .filter((c): c is LocalServerConfig => c.kind === 'local' && Boolean(local.get(c.id)?.running))
          .map((c) => local.get(c.id)!.stop(Math.min(c.stopTimeoutSec, 20) * 1000))
      )
    }
  }
}
