import { ChildProcess, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { delimiter } from 'node:path'
import type { Account, Settings } from '@shared/types'
import { GamePaths } from './paths'
import { Argument, VersionDetail } from './manifest'
import { isAllowed, mavenToPath } from './rules'
import { selectLibraries } from './installer'

const LAUNCHER_NAME = 'ArsFodina'
const LAUNCHER_VERSION = '1.0.0'

export interface LaunchOptions {
  paths: GamePaths
  version: VersionDetail
  instanceDir: string
  account: Account
  settings: Settings
  ramMb: number
  onLog: (stream: 'stdout' | 'stderr', line: string) => void
  onExit: (code: number | null) => void
}

export interface RunningGame {
  pid: number
  kill: () => void
}

function buildClasspath(paths: GamePaths, version: VersionDetail): string[] {
  const { classpath } = selectLibraries(version)
  const entries: string[] = []
  const seen = new Set<string>()
  for (const lib of classpath) {
    const rel = lib.downloads?.artifact?.path ?? mavenToPath(lib.name)
    const full = paths.library(rel)
    if (!seen.has(full)) {
      seen.add(full)
      entries.push(full)
    }
  }
  // Modern Forge/NeoForge installers produce net.minecraft:client as a
  // processed library and add its filename to ModLauncher's ignoreList. Adding
  // the vanilla versions/<id>/<id>.jar as well gives it a different automatic
  // module name and causes duplicate net.minecraft packages.
  const hasProcessedMinecraftClient = classpath.some((lib) => lib.name.startsWith('net.minecraft:client:'))
  if (!hasProcessedMinecraftClient) {
    // Vanilla client jar last so loader libraries take precedence.
    entries.push(paths.versionJar(version.inheritsFrom ?? version.id))
  }
  return entries
}

function placeholderMap(
  paths: GamePaths,
  version: VersionDetail,
  opts: LaunchOptions,
  classpath: string
): Record<string, string> {
  const assetsIndex = version.assets ?? version.assetIndex?.id ?? 'legacy'
  const legacyAssets = assetsIndex === 'legacy' || assetsIndex === 'pre-1.6'
  return {
    auth_player_name: opts.account.username,
    version_name: version.id,
    game_directory: opts.instanceDir,
    assets_root: paths.assets,
    game_assets: legacyAssets ? `${paths.assetsVirtual}/${assetsIndex}` : paths.assets,
    assets_index_name: assetsIndex,
    auth_uuid: opts.account.uuid.replace(/-/g, ''),
    auth_access_token: '0',
    auth_session: '0',
    clientid: '',
    auth_xuid: '',
    user_type: 'msa',
    user_properties: '{}',
    version_type: version.type,
    natives_directory: paths.nativesDir(version.id),
    launcher_name: LAUNCHER_NAME,
    launcher_version: LAUNCHER_VERSION,
    classpath,
    classpath_separator: delimiter,
    library_directory: paths.libraries,
    resolution_width: String(opts.settings.resolutionWidth),
    resolution_height: String(opts.settings.resolutionHeight)
  }
}

function substitute(token: string, map: Record<string, string>): string {
  return token.replace(/\$\{([^}]+)\}/g, (_, key: string) => map[key] ?? `\${${key}}`)
}

/** Flatten new-format argument arrays, applying rules + placeholder substitution. */
function resolveArguments(
  args: Argument[] | undefined,
  features: Record<string, boolean>,
  map: Record<string, string>
): string[] {
  const out: string[] = []
  for (const arg of args ?? []) {
    if (typeof arg === 'string') {
      out.push(substitute(arg, map))
    } else if (isAllowed(arg.rules, features)) {
      const values = Array.isArray(arg.value) ? arg.value : [arg.value]
      for (const v of values) out.push(substitute(v, map))
    }
  }
  return out
}

export async function launchGame(opts: LaunchOptions): Promise<RunningGame> {
  const { paths, version, settings } = opts
  if (!existsSync(opts.instanceDir)) await mkdir(opts.instanceDir, { recursive: true })

  const classpath = buildClasspath(paths, version).join(delimiter)
  const map = placeholderMap(paths, version, opts, classpath)

  const features: Record<string, boolean> = {
    is_demo_user: false,
    has_custom_resolution: !settings.fullscreen,
    has_quick_plays_support: false,
    is_quick_play_singleplayer: false,
    is_quick_play_multiplayer: false,
    is_quick_play_realms: false
  }

  const memArgs = [`-Xmx${opts.ramMb}M`, `-Xms${Math.min(opts.ramMb, 1024)}M`]
  const userJvm = settings.jvmArgs.trim() ? settings.jvmArgs.trim().split(/\s+/) : []

  let jvmArgs: string[]
  let gameArgs: string[]

  if (version.arguments) {
    jvmArgs = resolveArguments(version.arguments.jvm, features, map)
    gameArgs = resolveArguments(version.arguments.game, features, map)
  } else {
    // Legacy format: no JVM args in the JSON, supply the essentials ourselves.
    jvmArgs = ['-Djava.library.path=' + map.natives_directory, '-cp', classpath]
    gameArgs = (version.minecraftArguments ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => substitute(t, map))
  }

  jvmArgs = [...memArgs, ...userJvm, ...jvmArgs]
  if (settings.fullscreen) gameArgs.push('--fullscreen')

  const finalArgs = [...jvmArgs, version.mainClass, ...gameArgs]
  const javaPath = settings.javaPath || 'java'

  opts.onLog('stdout', `[Ars Fodina] Launching ${version.id} with ${javaPath}`)
  opts.onLog('stdout', `[Ars Fodina] ${javaPath} ${finalArgs.filter((a) => !a.includes(classpath)).join(' ')}`)

  const child: ChildProcess = spawn(javaPath, finalArgs, {
    cwd: opts.instanceDir,
    env: process.env,
    windowsHide: false
  })

  const rl = (buf: Buffer, stream: 'stdout' | 'stderr'): void => {
    for (const line of buf.toString('utf8').split(/\r?\n/)) {
      if (line.length) opts.onLog(stream, line)
    }
  }
  child.stdout?.on('data', (d: Buffer) => rl(d, 'stdout'))
  child.stderr?.on('data', (d: Buffer) => rl(d, 'stderr'))
  child.on('close', (code) => opts.onExit(code))
  child.on('error', (err) => {
    opts.onLog('stderr', `[Ars Fodina] Failed to start Java: ${err.message}`)
    opts.onExit(-1)
  })

  return {
    pid: child.pid ?? -1,
    kill: () => child.kill('SIGTERM')
  }
}
