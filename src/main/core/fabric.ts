import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { GamePaths } from './paths'
import { VersionDetail } from './manifest'
import { getJson } from './http'

/**
 * Fabric and Quilt install the same way: their meta service hands back a
 * complete version profile (mainClass + maven libraries, inheritsFrom the
 * vanilla version), which we persist so the standard installer can resolve it.
 * No Java, no installer jar, no patch processors - which is why these packs
 * install in seconds next to a Forge pack's minute.
 */

const META = {
  fabric: 'https://meta.fabricmc.net/v2',
  quilt: 'https://meta.quiltmc.org/v3'
} as const

export type FabricLike = keyof typeof META

interface LoaderEntry {
  loader: { version: string; stable?: boolean; build?: number }
  intermediary: { version: string }
}

export interface LoaderVersion {
  version: string
  stable: boolean
}

export async function getFabricLikeVersions(
  flavour: FabricLike,
  mcVersion: string
): Promise<LoaderVersion[]> {
  const entries = await getJson<LoaderEntry[]>(
    `${META[flavour]}/versions/loader/${encodeURIComponent(mcVersion)}`
  )
  return entries.map((entry) => ({
    version: entry.loader.version,
    // Quilt marks pre-releases in the version string rather than with a flag.
    stable: entry.loader.stable ?? !/beta|rc|pre/i.test(entry.loader.version)
  }))
}

/** Back-compat helper for callers that only ever wanted Fabric. */
export async function getFabricLoaderVersions(mcVersion: string): Promise<LoaderVersion[]> {
  return getFabricLikeVersions('fabric', mcVersion)
}

/**
 * Install Fabric or Quilt for a Minecraft version.
 * Returns the resulting version id to launch.
 */
export async function installFabricLike(
  flavour: FabricLike,
  paths: GamePaths,
  mcVersion: string,
  loaderVersion?: string
): Promise<string> {
  let loader = loaderVersion
  // Profiles are immutable per loader+game version, so a saved one is reusable
  // without asking the meta service again.
  if (loader) {
    const knownId = `${flavour}-loader-${loader}-${mcVersion}`
    if (existsSync(paths.versionJson(knownId))) return knownId
  }
  if (!loader) {
    const versions = await getFabricLikeVersions(flavour, mcVersion)
    const stable = versions.find((v) => v.stable) ?? versions[0]
    if (!stable) throw new Error(`No ${flavour} loader available for ${mcVersion}`)
    loader = stable.version
  }

  const profile = await getJson<VersionDetail>(
    `${META[flavour]}/versions/loader/${encodeURIComponent(mcVersion)}/${encodeURIComponent(loader)}/profile/json`
  )
  const dir = paths.versionDir(profile.id)
  if (!existsSync(dir)) await mkdir(dir, { recursive: true })
  await writeFile(paths.versionJson(profile.id), JSON.stringify(profile, null, 2))
  return profile.id
}

export async function installFabric(
  paths: GamePaths,
  mcVersion: string,
  loaderVersion?: string
): Promise<string> {
  return installFabricLike('fabric', paths, mcVersion, loaderVersion)
}
