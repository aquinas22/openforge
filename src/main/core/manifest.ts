import type { VersionSummary } from '@shared/types'
import { getJson } from './http'

const VERSION_MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
export const RESOURCES_BASE = 'https://resources.download.minecraft.net'

// ── Minecraft version JSON (piston-meta) — only the fields we consume ─────────

export interface Artifact {
  path?: string
  sha1: string
  size: number
  url: string
}

export interface OsRule {
  name?: 'windows' | 'osx' | 'linux'
  arch?: string
  version?: string
}

export interface Rule {
  action: 'allow' | 'disallow'
  os?: OsRule
  features?: Record<string, boolean>
}

export interface Library {
  name: string
  downloads?: {
    artifact?: Artifact
    classifiers?: Record<string, Artifact>
  }
  natives?: Record<string, string>
  extract?: { exclude?: string[] }
  rules?: Rule[]
  /** Fabric/Forge-style libraries that resolve from a maven repo by name. */
  url?: string
}

export type Argument = string | { rules: Rule[]; value: string | string[] }

export interface VersionDetail {
  id: string
  inheritsFrom?: string
  type: string
  mainClass: string
  assets?: string
  assetIndex?: { id: string; sha1: string; size: number; totalSize: number; url: string }
  downloads?: {
    client?: Artifact
    server?: Artifact
  }
  libraries: Library[]
  javaVersion?: { component: string; majorVersion: number }
  arguments?: { game: Argument[]; jvm: Argument[] }
  minecraftArguments?: string
  logging?: {
    client?: { argument: string; file: { id: string; sha1: string; size: number; url: string }; type: string }
  }
}

export interface AssetIndex {
  objects: Record<string, { hash: string; size: number }>
  virtual?: boolean
  map_to_resources?: boolean
}

interface RawManifest {
  latest: { release: string; snapshot: string }
  versions: VersionSummary[]
}

export async function fetchVersionManifest(): Promise<RawManifest> {
  return getJson<RawManifest>(VERSION_MANIFEST)
}

export async function fetchVersionDetail(url: string): Promise<VersionDetail> {
  return getJson<VersionDetail>(url)
}

export async function fetchAssetIndex(url: string): Promise<AssetIndex> {
  return getJson<AssetIndex>(url)
}
