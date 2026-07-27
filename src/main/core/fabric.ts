import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { GamePaths } from './paths'
import { VersionDetail } from './manifest'
import { getJson } from './http'

const FABRIC_META = 'https://meta.fabricmc.net/v2'

interface FabricLoaderEntry {
  loader: { version: string; stable: boolean; build: number }
  intermediary: { version: string }
}

export async function getFabricLoaderVersions(mcVersion: string): Promise<FabricLoaderEntry[]> {
  return getJson<FabricLoaderEntry[]>(`${FABRIC_META}/versions/loader/${encodeURIComponent(mcVersion)}`)
}

/**
 * Install Fabric for a Minecraft version. Fabric's meta service hands back a
 * complete version profile (mainClass + maven libraries, inheritsFrom the
 * vanilla version), which we persist so the standard installer can resolve it.
 * Returns the resulting version id to launch.
 */
export async function installFabric(
  paths: GamePaths,
  mcVersion: string,
  loaderVersion?: string
): Promise<string> {
  let loader = loaderVersion
  if (!loader) {
    const versions = await getFabricLoaderVersions(mcVersion)
    const stable = versions.find((v) => v.loader.stable) ?? versions[0]
    if (!stable) throw new Error(`No Fabric loader available for ${mcVersion}`)
    loader = stable.loader.version
  }

  const profile = await getJson<VersionDetail>(
    `${FABRIC_META}/versions/loader/${encodeURIComponent(mcVersion)}/${encodeURIComponent(loader)}/profile/json`
  )
  const dir = paths.versionDir(profile.id)
  if (!existsSync(dir)) await mkdir(dir, { recursive: true })
  await writeFile(paths.versionJson(profile.id), JSON.stringify(profile, null, 2))
  return profile.id
}
