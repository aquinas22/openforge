import type { ContentKind, ContentProject, LoaderType } from './types'

/**
 * Whether content fits an instance. Pure, shared by the installer (which picks
 * a version) and the instance content panel (which labels search results).
 *
 * Only mods are bound to a loader. Texture packs, shaders and data packs work
 * on any loader, so filtering those by loader would hide almost everything.
 */

/** Does any of these provider loader tags run on this instance's loader? */
export function loaderMatches(tags: string[], loader: LoaderType): boolean {
  if (loader === 'vanilla') return false
  return tags.some((raw) => {
    const tag = raw.toLowerCase().replace(/[\s_-]+/g, '')
    if (loader === 'neoforge') return tag === 'neoforge'
    // Quilt runs Fabric mods.
    if (loader === 'quilt') return tag === 'quilt' || tag === 'fabric'
    return tag === loader
  })
}

export type Fit = 'compatible' | 'unknown' | 'incompatible'

export interface FitReport {
  fit: Fit
  /** Short reason for the badge, e.g. "No 1.20.1 build". */
  reason: string
}

/**
 * Judge a search result against an instance from the listing metadata alone.
 * Listings can be incomplete (CurseForge only lists recent files), so missing
 * data is "unknown", never "incompatible"; the installer makes the final call
 * against the real version list.
 */
export function projectFit(
  project: Pick<ContentProject, 'gameVersions' | 'loaders'>,
  instance: { mcVersion: string; loader: LoaderType },
  kind: ContentKind
): FitReport {
  const versions = project.gameVersions ?? []
  if (versions.length && !versions.includes(instance.mcVersion)) {
    return { fit: 'incompatible', reason: `No ${instance.mcVersion} build listed` }
  }
  if (kind === 'mod') {
    if (instance.loader === 'vanilla') return { fit: 'incompatible', reason: 'Mods need a mod loader' }
    const loaders = project.loaders ?? []
    if (loaders.length && !loaderMatches(loaders, instance.loader)) {
      return { fit: 'incompatible', reason: `Not built for ${instance.loader}` }
    }
    if (!loaders.length || !versions.length) return { fit: 'unknown', reason: 'Checked when added' }
  }
  if (!versions.length) return { fit: 'unknown', reason: 'Checked when added' }
  return { fit: 'compatible', reason: `Fits ${instance.mcVersion}` }
}
