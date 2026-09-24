import { ChildProcess, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { delimiter } from 'node:path'
import type { LoaderType, Settings } from '@shared/types'
import { tunedJvmArgs } from '../../shared/tuning'
import type { LaunchAccount } from './accounts'
import { GamePaths } from './paths'
import { Argument, VersionDetail } from './manifest'
import { isAllowed, mavenToPath } from './rules'
import { selectLibraries, versionJarFor } from './installer'

const LAUNCHER_NAME = 'Openforge'
const LAUNCHER_VERSION = '2.0.0'

/** Jump straight into a world or server instead of the main menu. */
export interface QuickPlay {
  type: 'singleplayer' | 'multiplayer' | 'realms'
  /** World folder name, "host:port", or realm id. */
  id: string
}

export interface LaunchOptions {
  paths: GamePaths
  version: VersionDetail
  instanceDir: string
  account: LaunchAccount
  settings: Settings
  ramMb: number
  javaPath: string
  /** Major version of `javaPath`, which decides the GC defaults. */
  javaMajor: number
  /** The instance's loader; modded launches get a larger initial heap. */
  loader: LoaderType
  /** Per-instance JVM flags, appended after the global ones. */
  extraJvmArgs?: string
  quickPlay?: QuickPlay
  onLog: (stream: 'stdout' | 'stderr', line: string) => void
  onExit: (code: number | null) => void
  /** Coarse progress read from the game's own log: mods loading, then in game. */
  onStage?: (stage: LaunchStage) => void
}

export type LaunchStage = 'loading' | 'ready'

/**
 * Log lines that mark how far a starting game has got. The game's own output
 * is the only signal a launcher gets, and these lines are stable across
 * vanilla, Fabric, Quilt, Forge and NeoForge.
 */
export function stageFromLogLine(line: string): LaunchStage | null {
  if (/Sound engine started|SoundSystem started|OpenAL initialized|Created: \d+x\d+x\d+ minecraft:textures\/atlas/.test(line)) {
    return 'ready'
  }
  if (/Loading \d+ mods|ModLauncher running|Launching target|Setting user:|Backend library: LWJGL/i.test(line)) {
    return 'loading'
  }
  return null
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
    // Client jar last so loader libraries take precedence. For modded versions
    // this is the copy named after the loader version (see versionJarFor).
    entries.push(versionJarFor(paths, version))
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
    auth_access_token: opts.account.accessToken,
    auth_session: opts.account.accessToken,
    clientid: opts.account.clientId,
    auth_xuid: opts.account.xuid,
    // "msa" is what tells the client it has a real session and may talk to
    // online-mode servers; "legacy" keeps an offline profile local.
    user_type: opts.account.userType,
    user_properties: '{}',
    version_type: version.type,
    natives_directory: paths.nativesDir(version.id),
    launcher_name: LAUNCHER_NAME,
    launcher_version: LAUNCHER_VERSION,
    classpath,
    classpath_separator: delimiter,
    library_directory: paths.libraries,
    resolution_width: String(opts.settings.resolutionWidth),
    resolution_height: String(opts.settings.resolutionHeight),
    quickPlayPath: '',
    quickPlaySingleplayer: opts.quickPlay?.type === 'singleplayer' ? opts.quickPlay.id : '',
    quickPlayMultiplayer: opts.quickPlay?.type === 'multiplayer' ? opts.quickPlay.id : '',
    quickPlayRealms: opts.quickPlay?.type === 'realms' ? opts.quickPlay.id : ''
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

function splitArgs(value: string | undefined): string[] {
  return value?.trim() ? value.trim().split(/\s+/) : []
}

export async function launchGame(opts: LaunchOptions): Promise<RunningGame> {
  const { paths, version, settings } = opts
  if (!existsSync(opts.instanceDir)) await mkdir(opts.instanceDir, { recursive: true })

  const classpath = buildClasspath(paths, version).join(delimiter)
  const map = placeholderMap(paths, version, opts, classpath)

  const quickPlay = opts.quickPlay
  const features: Record<string, boolean> = {
    is_demo_user: false,
    has_custom_resolution: !settings.fullscreen,
    has_quick_plays_support: Boolean(quickPlay),
    is_quick_play_singleplayer: quickPlay?.type === 'singleplayer',
    is_quick_play_multiplayer: quickPlay?.type === 'multiplayer',
    is_quick_play_realms: quickPlay?.type === 'realms'
  }

  const userJvm = [...splitArgs(settings.jvmArgs), ...splitArgs(opts.extraJvmArgs)]
  const memArgs = tunedJvmArgs({
    javaMajor: opts.javaMajor,
    ramMb: opts.ramMb,
    loader: opts.loader,
    userArgs: userJvm.join(' ')
  })

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

  // Older profiles predate the quick-play feature flags, so add the flag by
  // hand when the version JSON never declared it.
  if (quickPlay && !gameArgs.some((arg) => arg.startsWith('--quickPlay'))) {
    const flag =
      quickPlay.type === 'multiplayer'
        ? '--quickPlayMultiplayer'
        : quickPlay.type === 'realms'
          ? '--quickPlayRealms'
          : '--quickPlaySingleplayer'
    gameArgs.push(flag, quickPlay.id)
  }

  const finalArgs = [...jvmArgs, version.mainClass, ...gameArgs]
  const javaPath = opts.javaPath || settings.javaPath || 'java'

  opts.onLog('stdout', `[Openforge] Launching ${version.id} with ${javaPath}`)
  const safeArgs = finalArgs
    .filter((arg) => !arg.includes(classpath))
    .map((arg) => (arg === opts.account.accessToken && arg !== '0' ? '<access-token>' : arg))
  opts.onLog('stdout', `[Openforge] ${javaPath} ${safeArgs.join(' ')}`)

  const child: ChildProcess = spawn(javaPath, finalArgs, {
    cwd: opts.instanceDir,
    env: process.env,
    windowsHide: false
  })

  let stage: LaunchStage | null = null
  const rl = (buf: Buffer, stream: 'stdout' | 'stderr'): void => {
    for (const line of buf.toString('utf8').split(/\r?\n/)) {
      if (!line.length) continue
      opts.onLog(stream, line)
      if (stage !== 'ready' && opts.onStage) {
        const next = stageFromLogLine(line)
        if (next && next !== stage) {
          stage = next
          opts.onStage(next)
        }
      }
    }
  }
  child.stdout?.on('data', (d: Buffer) => rl(d, 'stdout'))
  child.stderr?.on('data', (d: Buffer) => rl(d, 'stderr'))
  child.on('close', (code) => opts.onExit(code))
  child.on('error', (err) => {
    opts.onLog('stderr', `[Openforge] Failed to start Java: ${err.message}`)
    opts.onExit(-1)
  })

  return {
    pid: child.pid ?? -1,
    kill: () => child.kill('SIGTERM')
  }
}
