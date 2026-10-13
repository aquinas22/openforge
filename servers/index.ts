import { randomUUID, createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { Readable } from 'node:stream'
import type { DeployRemoteServerInput, RemoteSshTarget } from '../src/shared/ipc'
import type { RemoteHostInfo, RemoteServerDeployment, RemoteServerSummary, ServerDeploymentProgress, SshServerConfig } from '../src/shared/types'
import { buildSshArgs, classifySshError, validateSshTarget } from '../src/shared/ssh'
import type { CfClient } from '../src/main/core/curseforge'
import { runSsh } from '../src/main/core/servers/sshrun'
import { prepareDeployment, validateDeployInput, validateSlug } from './plan'
import { REMOTE_AGENT } from './remote'

/** Small command; the Python source and request travel through encrypted stdin. */
export const AGENT_COMMAND = "python3 -u -c 'import sys; n=int(sys.stdin.buffer.readline()); exec(compile(sys.stdin.buffer.read(n), \"<openforge>\", \"exec\"))'"

export function agentInput(request: unknown, archive?: Buffer): Readable {
  const script = Buffer.from(REMOTE_AGENT, 'utf8')
  return Readable.from([Buffer.from(String(script.length) + '\n'), script, Buffer.from(JSON.stringify(request) + '\n'), ...(archive ? [archive] : [])])
}

export function validateTarget(target: RemoteSshTarget): void {
  validateSshTarget(target)
  if (target.identityFile && (!isAbsolute(target.identityFile) || !existsSync(target.identityFile))) {
    throw new Error('Choose an existing private key file, or leave it empty to use ssh-agent.')
  }
}

async function runAgent<T>(target: RemoteSshTarget, request: unknown, opts: {
  archive?: Buffer
  signal?: AbortSignal
  report?: (phase: ServerDeploymentProgress['phase'], message: string) => void
} = {}): Promise<T> {
  validateTarget(target)
  let value: T | undefined
  let remoteError: string | undefined
  const phases = new Set(['resolving', 'uploading', 'extracting', 'downloading', 'java', 'loader', 'ready', 'error'])
  const result = await runSsh(buildSshArgs(target, AGENT_COMMAND), opts.archive ? 30 * 60_000 : 30_000, {
    input: agentInput(request, opts.archive),
    signal: opts.signal,
    onLine: (_stream, line) => {
      if (!line.startsWith('OPENFORGE:')) return
      try {
        const event = JSON.parse(line.slice('OPENFORGE:'.length))
        if (event.kind === 'result') value = event.value as T
        if (event.kind === 'error') remoteError = String(event.message).slice(0, 4000)
        if (event.kind === 'progress' && phases.has(event.phase)) opts.report?.(event.phase, String(event.message).slice(0, 1000))
      } catch { /* A login banner or partial line is not protocol output. */ }
    }
  })
  if (opts.signal?.aborted) throw new Error('Deployment cancelled.')
  if (result.code !== 0 || value === undefined) {
    if (remoteError) throw new Error(remoteError)
    if (/python3.*(?:not found|No such file)/i.test(result.stderr)) throw new Error('Install Python 3.9 or newer on the SSH server first.')
    throw new Error(classifySshError(result.stderr, result.code, result.timedOut).message)
  }
  return value
}

/** Read-only inspection; it does not create ~/minecraft-servers. */
export async function inspectRemoteHost(target: RemoteSshTarget, signal?: AbortSignal): Promise<RemoteHostInfo> {
  const host = await runAgent<RemoteHostInfo>(target, { action: 'inspect' }, { signal })
  if (!Array.isArray(host.servers) || typeof host.tmux !== 'boolean' || !Number.isFinite(host.freeDiskMb)) throw new Error('The host returned invalid server information.')
  return host
}

function validateDeployment(deployment: RemoteServerDeployment, slug: string): void {
  validateSlug(slug)
  if (!deployment || deployment.slug !== slug || !['vanilla', 'modrinth', 'curseforge'].includes(deployment.source) ||
      !['vanilla', 'forge', 'neoforge', 'fabric', 'quilt'].includes(deployment.loader) ||
      typeof deployment.mcVersion !== 'string' || !deployment.mcVersion || deployment.mcVersion.length > 100 ||
      !Number.isInteger(deployment.javaMajor) || deployment.javaMajor < 8 || deployment.javaMajor > 100 ||
      !Number.isInteger(deployment.ramMb) || deployment.ramMb < 512 || deployment.ramMb > 262144 ||
      !Number.isInteger(deployment.gamePort) || deployment.gamePort < 1 || deployment.gamePort > 65535) {
    throw new Error('This folder has invalid OpenForge server metadata.')
  }
}

export function configFromRemote(target: RemoteSshTarget, summary: RemoteServerSummary): SshServerConfig {
  validateTarget(target)
  validateDeployment(summary.deployment!, summary.slug)
  if (typeof summary.name !== 'string' || !summary.name.trim() || summary.name.length > 60 || /[\0-\x1f\x7f]/.test(summary.name)) throw new Error('Invalid remote server name.')
  return {
    id: randomUUID(), kind: 'ssh', name: summary.name, createdAt: new Date().toISOString(),
    host: target.host.trim(), port: target.port, user: target.user, identityFile: target.identityFile,
    control: 'tmux', session: 'openforge-' + summary.slug, unit: '',
    serverDir: '~/minecraft-servers/' + summary.slug, startScript: './openforge-start.sh',
    logPath: 'logs/latest.log', startCommand: '', stopCommand: '', statusCommand: '', sendCommand: '', tailCommand: '',
    deployment: summary.deployment
  }
}

export async function deployRemoteServer(input: DeployRemoteServerInput, deps: {
  cf: CfClient
  signal?: AbortSignal
  report: (event: ServerDeploymentProgress) => void
}): Promise<SshServerConfig> {
  validateDeployInput(input)
  validateTarget(input.target)
  const report = (phase: ServerDeploymentProgress['phase'], message: string): void => deps.report({ requestId: input.requestId, phase, message })
  report('resolving', 'Checking the SSH host')
  const host = await inspectRemoteHost(input.target, deps.signal)
  if (!host.tmux) throw new Error('Install tmux on the SSH server first (for example: sudo apt install tmux).')
  if (host.servers.some((entry) => entry.slug === input.slug)) throw new Error('That server folder already exists. Choose a different folder or import it.')
  const tempDir = await mkdtemp(join(tmpdir(), 'openforge-server-'))
  try {
    const prepared = await prepareDeployment(input, { cf: deps.cf, tempDir, signal: deps.signal, report: (message) => report('resolving', message) })
    report('uploading', 'Uploading server files over SSH')
    const summary = await runAgent<RemoteServerSummary>(input.target, {
      action: 'deploy', plan: prepared.plan, archiveSize: prepared.archive.length,
      archiveSha256: createHash('sha256').update(prepared.archive).digest('hex')
    }, { archive: prepared.archive, signal: deps.signal, report })
    return configFromRemote(input.target, summary)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

export async function importRemoteServer(target: RemoteSshTarget, slug: string): Promise<SshServerConfig> {
  validateSlug(slug)
  const host = await inspectRemoteHost(target)
  const summary = host.servers.find((entry) => entry.slug === slug)
  if (!summary?.deployment) throw new Error('This folder was not deployed by OpenForge. Add it as an existing SSH server and choose its start script.')
  return configFromRemote(target, summary)
}
