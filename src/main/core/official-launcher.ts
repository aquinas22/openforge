import { app, shell } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { copyFile, link, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { Instance, Settings } from '@shared/types'
import { GamePaths } from './paths'
import { detectLauncherInstall } from './ownership'

const execFileAsync = promisify(execFile)

interface LauncherProfile {
  created: string
  gameDir: string
  icon: string
  javaArgs: string
  lastUsed: string
  lastVersionId: string
  name: string
  type: 'custom'
}

interface LauncherProfiles {
  profiles?: Record<string, LauncherProfile | Record<string, unknown>>
  [key: string]: unknown
}

/** The official launcher's data folder (%APPDATA%\.minecraft on Windows). */
export function minecraftDir(): string {
  // Development/demo only, like OPENFORGE_USER_DATA in index.ts: an isolated,
  // unpackaged run can point at a stand-in folder so tests never read or write
  // the real launcher's files. Packaged builds ignore both variables.
  const standIn = process.env['OPENFORGE_MINECRAFT_DIR']
  if (!app.isPackaged && process.env['OPENFORGE_USER_DATA'] && standIn) return standIn
  if (process.platform === 'win32') return join(app.getPath('appData'), '.minecraft')
  if (process.platform === 'darwin') return join(app.getPath('home'), 'Library', 'Application Support', 'minecraft')
  return join(app.getPath('home'), '.minecraft')
}

async function mirrorFile(source: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true })
  try {
    const sourceStat = await stat(source)
    const destinationStat = await stat(destination).catch(() => null)
    if (destinationStat?.size === sourceStat.size) return
    if (destinationStat) await unlink(destination)
    await link(source, destination)
  } catch {
    await copyFile(source, destination)
  }
}

async function mirrorTree(source: string, destination: string): Promise<void> {
  if (!existsSync(source)) return
  await mkdir(destination, { recursive: true })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name)
    const to = join(destination, entry.name)
    if (entry.isDirectory()) await mirrorTree(from, to)
    else if (entry.isFile()) await mirrorFile(from, to)
  }
}

async function updateProfiles(
  file: string,
  profileId: string,
  profile: LauncherProfile
): Promise<void> {
  let data: LauncherProfiles = {}
  try {
    data = JSON.parse(await readFile(file, 'utf8')) as LauncherProfiles
  } catch {
    // The launcher creates the remaining top-level settings on first run.
  }
  data.profiles = { ...(data.profiles ?? {}), [profileId]: profile }
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.openforge.tmp`
  await writeFile(temporary, JSON.stringify(data, null, 2), 'utf8')
  await rename(temporary, file)
}

/**
 * Mirror immutable game artifacts into the official launcher's shared store,
 * then point a launcher installation at Openforge's instance directory.
 */
export async function registerOfficialProfile(
  paths: GamePaths,
  instance: Instance,
  settings: Settings,
  versionId: string
): Promise<void> {
  const official = minecraftDir()
  await Promise.all([
    mirrorTree(paths.assets, join(official, 'assets')),
    mirrorTree(paths.libraries, join(official, 'libraries')),
    mirrorTree(paths.versions, join(official, 'versions'))
  ])

  const now = new Date().toISOString()
  const profileId = `openforge-${instance.id}`
  const profile: LauncherProfile = {
    created: now,
    gameDir: paths.instanceDir(instance.id),
    icon: 'Furnace',
    javaArgs: `-Xmx${instance.ramMb ?? settings.ramMb}M ${settings.jvmArgs}`.trim(),
    lastUsed: now,
    lastVersionId: versionId,
    name: `Openforge · ${instance.name}`,
    type: 'custom'
  }

  const classic = join(official, 'launcher_profiles.json')
  const store = join(official, 'launcher_profiles_microsoft_store.json')
  const targets = existsSync(store) ? [store, classic] : [classic]
  await Promise.all(targets.map((file) => updateProfiles(file, profileId, profile)))
}

export async function openOfficialLauncher(): Promise<void> {
  if (process.platform === 'win32') {
    const install = detectLauncherInstall(process.env)
    if (install.kind === 'legacy' && install.path) {
      const child = spawn(install.path, [], { detached: true, stdio: 'ignore' })
      child.unref()
      return
    }

    // Microsoft Store apps live in a protected WindowsApps directory. Resolve
    // the registered Start-menu AppID instead of guessing that filesystem path.
    try {
      const command =
        "Get-StartApps | Where-Object { $_.Name -like '*Minecraft Launcher*' } | Select-Object -First 1 -ExpandProperty AppID"
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
        { windowsHide: true, timeout: 10_000 }
      )
      const appId = stdout.trim()
      if (appId && !/[\r\n]/.test(appId)) {
        const child = spawn('explorer.exe', [`shell:AppsFolder\\${appId}`], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true
        })
        child.unref()
        return
      }
    } catch {
      // Fall through to the protocol and Store page fallbacks.
    }

    try {
      await shell.openExternal('minecraft://')
      return
    } catch {
      await shell.openExternal('ms-windows-store://search/?query=Minecraft Launcher')
      throw new Error(
        'Minecraft Launcher is not installed or Windows could not start it. The Microsoft Store has been opened so you can install or repair it.'
      )
    }
  }
  const candidates =
    process.platform === 'darwin'
      ? ['/Applications/Minecraft.app']
      : ['/usr/bin/minecraft-launcher', '/usr/local/bin/minecraft-launcher']
  const launcher = candidates.find(existsSync)
  if (!launcher) {
    throw new Error('Minecraft Launcher was not found. Install the official launcher, then try again.')
  }
  const error = await shell.openPath(launcher)
  if (error) throw new Error(error)
}
