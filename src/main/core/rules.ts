import type { Library, Rule } from './manifest'

export type OsName = 'windows' | 'osx' | 'linux'

export function currentOsName(): OsName {
  switch (process.platform) {
    case 'win32':
      return 'windows'
    case 'darwin':
      return 'osx'
    default:
      return 'linux'
  }
}

export function currentArch(): string {
  // Minecraft uses "x86" (32), "x64"/"amd64", "arm64".
  if (process.arch === 'x64') return 'x64'
  if (process.arch === 'ia32') return 'x86'
  return process.arch
}

function osMatches(os: NonNullable<Rule['os']>): boolean {
  if (os.name && os.name !== currentOsName()) return false
  if (os.arch) {
    const want = os.arch === 'x86' ? 'x86' : os.arch
    if (want !== currentArch() && !(want === 'x86_64' && currentArch() === 'x64')) return false
  }
  return true
}

/**
 * Evaluate Mojang allow/disallow rules against the current OS and feature flags
 * (e.g. is_demo_user, has_custom_resolution). No rules ⇒ allowed.
 */
export function isAllowed(rules: Rule[] | undefined, features: Record<string, boolean> = {}): boolean {
  if (!rules || rules.length === 0) return true
  let allowed = false
  for (const rule of rules) {
    let applies = true
    if (rule.os && !osMatches(rule.os)) applies = false
    if (rule.features) {
      for (const [key, val] of Object.entries(rule.features)) {
        if ((features[key] ?? false) !== val) applies = false
      }
    }
    if (applies) allowed = rule.action === 'allow'
  }
  return allowed
}

/** The natives classifier for this OS, with ${arch} substituted, or null. */
export function nativeClassifier(lib: Library): string | null {
  if (lib.natives) {
    const key = lib.natives[currentOsName()]
    if (!key) return null
    return key.replace('${arch}', process.arch === 'ia32' ? '32' : '64')
  }

  // Since 1.19-era manifests, Mojang may represent each native as a separate
  // Maven coordinate whose classifier is downloaded as `artifact`, rather
  // than through downloads.classifiers + natives.
  const classifier = lib.name.split(':')[3]
  if (!classifier?.startsWith('natives-')) return null
  const os = currentOsName()
  const osToken = os === 'osx' ? 'macos' : os
  if (!classifier.includes(osToken) && !(os === 'osx' && classifier.includes('osx'))) return null
  const wantsArm = /arm64|aarch64/.test(classifier)
  const wantsX86 = /(?:^|-)x86(?:-|$)/.test(classifier)
  if (process.arch === 'arm64') return wantsArm ? classifier : null
  if (process.arch === 'ia32') return wantsX86 ? classifier : null
  if (wantsArm || wantsX86) return null
  return classifier
}

/**
 * Convert a maven coordinate to a relative path.
 *   "net.fabricmc:fabric-loader:0.15.0"        -> net/fabricmc/fabric-loader/0.15.0/fabric-loader-0.15.0.jar
 *   "org.lwjgl:lwjgl:3.3.1:natives-windows"    -> .../lwjgl-3.3.1-natives-windows.jar
 *   "de.oceanlabs.mcp:mcp_config:1.20.1@zip"   -> .../mcp_config-1.20.1.zip
 */
export function mavenToPath(name: string): string {
  let coord = name
  let ext = 'jar'
  const at = coord.indexOf('@')
  if (at >= 0) {
    ext = coord.slice(at + 1)
    coord = coord.slice(0, at)
  }
  const parts = coord.split(':')
  const [group, artifact, version, classifier] = parts
  const groupPath = group.replace(/\./g, '/')
  const fileName = classifier
    ? `${artifact}-${version}-${classifier}.${ext}`
    : `${artifact}-${version}.${ext}`
  return `${groupPath}/${artifact}/${version}/${fileName}`
}
