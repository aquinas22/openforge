import AdmZip from 'adm-zip'
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { LoaderType } from '@shared/types'
import { GamePaths } from './paths'
import { downloadFile, getJson, getText } from './http'
import type { Reporter } from './installer'

export interface LoaderVersion {
  version: string
  stable: boolean
}

const FORGE_MAVEN = 'https://maven.minecraftforge.net/net/minecraftforge/forge'
const NEO_MAVEN = 'https://maven.neoforged.net/releases/net/neoforged'

/**
 * Build the installer URL for a Forge or NeoForge build.
 *
 * Forge:            net/minecraftforge/forge/<mc>-<ver>/forge-<mc>-<ver>-installer.jar
 * NeoForge (1.20.1): net/neoforged/forge/1.20.1-<ver>/forge-1.20.1-<ver>-installer.jar
 * NeoForge (1.20.2+): net/neoforged/neoforge/<ver>/neoforge-<ver>-installer.jar
 */
export function installerUrl(loader: LoaderType, mcVersion: string, version: string): string {
  if (loader === 'neoforge') {
    // NeoForge dropped the mc-prefixed scheme after 1.20.1.
    if (mcVersion === '1.20.1' || version.startsWith('1.20.1-')) {
      const full = version.startsWith('1.20.1-') ? version : `1.20.1-${version}`
      return `${NEO_MAVEN}/forge/${full}/forge-${full}-installer.jar`
    }
    return `${NEO_MAVEN}/neoforge/${version}/neoforge-${version}-installer.jar`
  }
  const full = version.startsWith(`${mcVersion}-`) ? version : `${mcVersion}-${version}`
  return `${FORGE_MAVEN}/${full}/forge-${full}-installer.jar`
}

function compareDesc(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((n) => parseInt(n, 10) || 0)
  const pb = b.split(/[.-]/).map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pb[i] ?? 0) !== (pa[i] ?? 0)) return (pb[i] ?? 0) - (pa[i] ?? 0)
  }
  return 0
}

/** Recommended + latest Forge builds for a Minecraft version. */
export async function getForgeVersions(mcVersion: string): Promise<LoaderVersion[]> {
  const data = await getJson<{ promos: Record<string, string> }>(
    'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json'
  )
  const recommended = data.promos[`${mcVersion}-recommended`]
  const latest = data.promos[`${mcVersion}-latest`]
  const out: LoaderVersion[] = []
  if (recommended) out.push({ version: recommended, stable: true })
  if (latest && latest !== recommended) out.push({ version: latest, stable: false })
  return out
}

/** NeoForge builds matching a Minecraft version (version scheme encodes the MC). */
export async function getNeoForgeVersions(mcVersion: string): Promise<LoaderVersion[]> {
  if (mcVersion === '1.20.1') {
    const xml = await getText('https://maven.neoforged.net/releases/net/neoforged/forge/maven-metadata.xml')
    const versions = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1])
    return versions
      .filter((v) => v.startsWith('1.20.1-'))
      .sort(compareDesc)
      .slice(0, 40)
      .map((version, i) => ({ version, stable: i === 0 }))
  }
  const parts = mcVersion.split('.')
  const prefix = `${parts[1]}.${parts[2] ?? '0'}.`
  const xml = await getText('https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml')
  const versions = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1])
  const matching = versions.filter((v) => v.startsWith(prefix) && !/beta/i.test(v)).sort(compareDesc)
  const list = (matching.length ? matching : versions.filter((v) => v.startsWith(prefix)).sort(compareDesc)).slice(0, 40)
  return list.map((version, i) => ({ version, stable: i === 0 }))
}

/** The installer refuses to run without a launcher_profiles.json in the target. */
function ensureLauncherProfiles(root: string): void {
  const p = join(root, 'launcher_profiles.json')
  if (!existsSync(p)) {
    writeFileSync(p, JSON.stringify({ profiles: {}, version: 3, settings: {} }, null, 2))
  }
}

/** Read the version id the installer will create from its embedded version.json. */
function installerVersionId(installerJar: string): string | null {
  try {
    const zip = new AdmZip(installerJar)
    const entry = zip.getEntry('version.json')
    if (!entry) return null
    return (JSON.parse(zip.readAsText(entry)).id as string) ?? null
  } catch {
    return null
  }
}

/**
 * Provision a Forge/NeoForge client by running the official installer headlessly
 * (`--installClient`). It downloads loader libraries and runs the patch
 * processors, writing versions/<id>/<id>.json + libraries into our game dir —
 * the same layout the vanilla installer and launcher already use.
 *
 * Returns the created version id, which the standard installer then resolves
 * (it inheritsFrom the vanilla version) to finish assets/natives.
 */
export async function installForgeLike(opts: {
  paths: GamePaths
  loader: LoaderType
  mcVersion: string
  version: string
  javaPath: string
  report: Reporter
  onLog?: (line: string) => void
}): Promise<string> {
  const { paths, loader, mcVersion, version, javaPath, report, onLog } = opts
  const label = loader === 'neoforge' ? 'NeoForge' : 'Forge'

  const url = installerUrl(loader, mcVersion, version)
  const installersDir = join(paths.root, 'installers')
  await mkdir(installersDir, { recursive: true })
  const jar = join(installersDir, url.split('/').pop()!)

  report('loader', `Downloading ${label} installer`, -1, version)
  await downloadFile({ url, dest: jar })

  ensureLauncherProfiles(paths.root)
  await mkdir(paths.versions, { recursive: true })
  const before = new Set(readdirSync(paths.versions))
  const expectedId = installerVersionId(jar)

  report('loader', `Installing ${label} (running processors)`, -1, 'this can take a minute')

  await new Promise<void>((resolve, reject) => {
    const child = spawn(javaPath, ['-jar', jar, '--installClient', paths.root], {
      cwd: paths.root,
      windowsHide: true
    })
    const onData = (buf: Buffer): void => {
      for (const line of buf.toString('utf8').split(/\r?\n/)) {
        if (!line.trim()) continue
        onLog?.(line)
        report('loader', `Installing ${label}`, -1, line.slice(0, 90))
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${label} installer exited with code ${code}`))
    )
  })

  // Prefer the id declared by the installer; fall back to the newly created dir.
  if (expectedId && existsSync(paths.versionJson(expectedId))) return expectedId
  const created = readdirSync(paths.versions).filter((d) => !before.has(d))
  const forgeDir =
    created.find((d) => /forge/i.test(d)) ?? created.find((d) => d !== mcVersion) ?? created[0]
  if (!forgeDir || !existsSync(paths.versionJson(forgeDir))) {
    throw new Error(`${label} installer finished but no version profile was created.`)
  }
  return forgeDir
}
