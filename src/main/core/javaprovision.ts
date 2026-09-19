import AdmZip from 'adm-zip'
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { chmod, mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { JavaInfo } from '@shared/types'
import { GamePaths } from './paths'
import { downloadFile, getJson } from './http'
import { probeJava } from './java'
import type { Reporter } from './installer'

/**
 * Downloads and manages Eclipse Temurin runtimes.
 *
 * "Install Java yourself, then come back" is the single most common reason a
 * new player never gets a modpack running. Minecraft pins an exact major
 * version per release (8, 16, 17, 21, and 25 for the newest builds), and a pack
 * built for one will not start on another. Openforge fetches the right one on
 * demand and keeps it beside the game files, so the game just starts.
 */

const ADOPTIUM = 'https://api.adoptium.net/v3'

/** Majors Minecraft actually asks for, with what each covers. */
export const SUPPORTED_MAJORS: { major: number; usedFor: string }[] = [
  { major: 8, usedFor: 'Minecraft 1.16.5 and older' },
  { major: 17, usedFor: 'Minecraft 1.17 - 1.20.4' },
  { major: 21, usedFor: 'Minecraft 1.20.5 - 1.21.x' },
  { major: 25, usedFor: 'The newest Minecraft builds' }
]

interface AdoptiumAsset {
  release_name: string
  version?: { semver?: string }
  binary: {
    image_type: string
    os: string
    architecture: string
    package: { name: string; link: string; size?: number; checksum?: string }
  }
}

function adoptiumOs(): string {
  if (process.platform === 'win32') return 'windows'
  if (process.platform === 'darwin') return 'mac'
  return 'linux'
}

function adoptiumArch(): string {
  switch (process.arch) {
    case 'arm64':
      return 'aarch64'
    case 'x64':
      return 'x64'
    case 'ia32':
      return 'x86'
    default:
      return 'x64'
  }
}

const javaBin = (): string => (process.platform === 'win32' ? 'java.exe' : 'java')

/** Where a managed runtime for one major version lives. */
export function runtimeDir(paths: GamePaths, major: number): string {
  return join(paths.root, 'runtimes', `temurin-${major}`)
}

/**
 * Find the `java` executable inside an extracted Temurin tree. The archive
 * unpacks to a single versioned folder, and macOS buries it another two levels
 * down inside a .app-style bundle.
 */
export function findJavaExecutable(root: string): string | null {
  if (!existsSync(root)) return null
  const direct = join(root, 'bin', javaBin())
  if (existsSync(direct)) return direct
  const macOs = join(root, 'Contents', 'Home', 'bin', javaBin())
  if (existsSync(macOs)) return macOs
  let entries: string[]
  try {
    entries = readdirSyncSafe(root)
  } catch {
    return null
  }
  for (const entry of entries) {
    const found = findJavaExecutable(join(root, entry))
    if (found) return found
  }
  return null
}

/** Sub-directories of `dir`, ignoring anything we cannot stat. */
function readdirSyncSafe(dir: string): string[] {
  return readdirSync(dir).filter((entry) => {
    try {
      return statSync(join(dir, entry)).isDirectory()
    } catch {
      return false
    }
  })
}

/** The managed runtime for a major version, if it is already installed. */
export async function managedRuntime(paths: GamePaths, major: number): Promise<JavaInfo | null> {
  const executable = findJavaExecutable(runtimeDir(paths, major))
  if (!executable) return null
  const info = await probeJava(executable)
  return info ? { ...info, managed: true, vendor: 'Eclipse Temurin' } : null
}

export async function listManagedRuntimes(paths: GamePaths): Promise<JavaInfo[]> {
  const found: JavaInfo[] = []
  for (const { major } of SUPPORTED_MAJORS) {
    const runtime = await managedRuntime(paths, major)
    if (runtime) found.push(runtime)
  }
  return found
}

async function latestAsset(major: number, imageType: 'jre' | 'jdk'): Promise<AdoptiumAsset | null> {
  const url =
    `${ADOPTIUM}/assets/latest/${major}/hotspot` +
    `?architecture=${adoptiumArch()}&image_type=${imageType}&os=${adoptiumOs()}&vendor=eclipse`
  const assets = await getJson<AdoptiumAsset[]>(url)
  return assets[0] ?? null
}

async function extractArchive(archive: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true })
  if (archive.endsWith('.zip')) {
    const zip = new AdmZip(archive)
    await new Promise<void>((resolveExtract, reject) => {
      zip.extractAllToAsync(target, true, false, (err) => (err ? reject(err) : resolveExtract()))
    })
    return
  }
  // .tar.gz on macOS/Linux; `tar` ships with Windows 10+ too, but we never take
  // this path there.
  await new Promise<void>((resolveExtract, reject) => {
    const child = spawn('tar', ['-xzf', archive, '-C', target], { windowsHide: true })
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolveExtract() : reject(new Error(`tar exited with code ${code}`))
    )
  })
}

/**
 * Ensure a Temurin runtime for `major` exists, downloading it if needed.
 * Returns the probed runtime, so the caller can launch with it straight away.
 */
export async function ensureRuntime(
  paths: GamePaths,
  major: number,
  report?: Reporter
): Promise<JavaInfo> {
  const existing = await managedRuntime(paths, major)
  if (existing) return existing

  report?.('java', `Fetching Java ${major}`, -1, 'Eclipse Temurin')
  // A JRE is roughly half the size of a JDK and is all the game needs. Forge's
  // installer is happy with it too, so only fall back to a JDK if no JRE is
  // published for this platform/major (true for some early access builds).
  const asset = (await latestAsset(major, 'jre')) ?? (await latestAsset(major, 'jdk'))
  if (!asset) {
    throw new Error(
      `Eclipse Temurin publishes no Java ${major} build for ${adoptiumOs()}/${adoptiumArch()}. ` +
        'Install a matching JDK manually and point at it in Settings.'
    )
  }

  const { link, name, size, checksum } = asset.binary.package
  const archive = join(tmpdir(), `openforge-${name}`)
  report?.('java', `Downloading Java ${major}`, -1, asset.release_name)
  await downloadFile({ url: link, dest: archive, size, sha256: checksum })

  report?.('java', `Installing Java ${major}`, -1, asset.release_name)
  const target = runtimeDir(paths, major)
  const staging = `${target}.incoming`
  await rm(staging, { recursive: true, force: true })
  await extractArchive(archive, staging)
  await rm(target, { recursive: true, force: true })
  await rename(staging, target)
  await rm(archive, { force: true }).catch(() => undefined)

  const executable = findJavaExecutable(target)
  if (!executable) {
    throw new Error(`The Java ${major} download did not contain a runnable java binary.`)
  }
  if (process.platform !== 'win32') {
    await chmod(executable, 0o755).catch(() => undefined)
  }

  const info = await probeJava(executable)
  if (!info) throw new Error(`The downloaded Java ${major} runtime did not run.`)
  report?.('java', `Java ${major} ready`, 1, info.version)
  return { ...info, managed: true, vendor: 'Eclipse Temurin' }
}

export async function removeRuntime(paths: GamePaths, major: number): Promise<void> {
  await rm(runtimeDir(paths, major), { recursive: true, force: true })
}

/** Round a Minecraft-required major up to the nearest runtime we can fetch. */
export function provisionableMajor(requiredMajor: number): number {
  const exact = SUPPORTED_MAJORS.find((entry) => entry.major === requiredMajor)
  if (exact) return exact.major
  const higher = SUPPORTED_MAJORS.filter((entry) => entry.major >= requiredMajor)
  return higher.length ? higher[0].major : SUPPORTED_MAJORS[SUPPORTED_MAJORS.length - 1].major
}
