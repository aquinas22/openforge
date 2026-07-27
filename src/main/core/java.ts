import { execFile } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { JavaInfo } from '@shared/types'

const execFileAsync = promisify(execFile)

const JAVA_BIN = process.platform === 'win32' ? 'java.exe' : 'java'

/** Parse `java -version` output (it prints to stderr). */
function parseVersion(output: string): { version: string; major: number } | null {
  const m = output.match(/version "([^"]+)"/)
  if (!m) return null
  const version = m[1]
  // "1.8.0_392" -> 8 ; "17.0.9" / "21" -> that major
  let major: number
  if (version.startsWith('1.')) major = parseInt(version.split('.')[1], 10)
  else major = parseInt(version.split('.')[0], 10)
  return { version, major: Number.isFinite(major) ? major : 0 }
}

export async function probeJava(path: string): Promise<JavaInfo | null> {
  try {
    const { stderr, stdout } = await execFileAsync(path, ['-version'], { timeout: 8000 })
    const parsed = parseVersion(stderr || stdout)
    if (!parsed) return null
    return { path, version: parsed.version, majorVersion: parsed.major }
  } catch {
    return null
  }
}

function windowsCandidates(): string[] {
  const roots = [
    process.env['ProgramFiles'],
    process.env['ProgramFiles(x86)'],
    process.env['LOCALAPPDATA'] && join(process.env['LOCALAPPDATA'], 'Programs')
  ].filter(Boolean) as string[]

  const vendors = ['Java', 'Eclipse Adoptium', 'Eclipse Foundation', 'Microsoft', 'Zulu', 'BellSoft', 'Amazon Corretto']
  const found: string[] = []
  for (const root of roots) {
    for (const vendor of vendors) {
      const base = join(root, vendor)
      if (!existsSync(base)) continue
      try {
        for (const entry of readdirSync(base)) {
          const candidate = join(base, entry, 'bin', JAVA_BIN)
          if (existsSync(candidate)) found.push(candidate)
        }
      } catch {
        /* unreadable dir — skip */
      }
    }
  }
  return found
}

/** Discover all usable Java runtimes, best (highest major) first. */
export async function discoverJava(preferred?: string): Promise<JavaInfo[]> {
  const candidates = new Set<string>()
  if (preferred) candidates.add(preferred)
  if (process.env.JAVA_HOME) candidates.add(join(process.env.JAVA_HOME, 'bin', JAVA_BIN))
  candidates.add(JAVA_BIN) // whatever is on PATH
  if (process.platform === 'win32') windowsCandidates().forEach((c) => candidates.add(c))

  const results: JavaInfo[] = []
  const seen = new Set<string>()
  for (const path of candidates) {
    const info = await probeJava(path)
    if (info && !seen.has(info.version + info.path)) {
      seen.add(info.version + info.path)
      results.push(info)
    }
  }
  return results.sort((a, b) => b.majorVersion - a.majorVersion)
}

/**
 * Pick the best Java for a given required major version. Modern Minecraft ships
 * a `javaVersion.majorVersion` in its version JSON (8, 16, 17, or 21).
 */
export async function selectJava(requiredMajor: number, preferred?: string): Promise<JavaInfo | null> {
  const all = await discoverJava(preferred)
  if (all.length === 0) return null
  const exact = all.find((j) => j.majorVersion === requiredMajor)
  if (exact) return exact
  const higher = all.filter((j) => j.majorVersion >= requiredMajor).sort((a, b) => a.majorVersion - b.majorVersion)
  if (higher.length) return higher[0]
  // Nothing meets the requirement. Never fall back to an older runtime — modern
  // Minecraft is compiled for a newer class-file version (and passes JVM flags
  // that only newer JDKs recognize), so an older Java can't launch it at all.
  return null
}
