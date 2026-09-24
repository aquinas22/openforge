import type { LoaderType } from './types'

/**
 * JVM defaults for launches. Pure functions, shared by the main process (which
 * builds the command line) and the renderer (which shows what will be used).
 */

const round256 = (mb: number): number => Math.round(mb / 256) * 256

/**
 * A sensible heap for this machine and pack. Modded Minecraft needs far more
 * than vanilla, but past ~10 GB a bigger heap only makes each GC pause longer.
 * Never recommends more than half of physical RAM or the launcher's safe max.
 */
export function recommendedRamMb(input: {
  totalMemoryMb: number
  maxRamMb: number
  loader: LoaderType
  modCount?: number
}): number {
  const { totalMemoryMb, maxRamMb, loader } = input
  const mods = input.modCount ?? 0
  let want: number
  if (loader === 'vanilla') want = totalMemoryMb >= 8192 ? 3072 : 2048
  else if (mods >= 300) want = 10240
  else if (mods >= 200) want = 8192
  else if (mods >= 100) want = 6144
  else want = 4096
  const ceiling = Math.min(maxRamMb, Math.max(1024, Math.floor(totalMemoryMb / 2)))
  return Math.max(1024, round256(Math.min(want, ceiling)))
}

/** True when the user already chose a garbage collector; we never override that. */
export function hasCustomGc(args: string): boolean {
  return /-XX:[+]Use\w*GC\b/.test(args)
}

/**
 * Garbage-collector flags for the Java major that will run the game.
 *  - Java 8: Mojang's own launcher defaults (G1 with a large region size).
 *  - Java 9+: G1 tuned for short pauses with a big young generation, the
 *    widely used modded-client profile. Stable across 17, 21 and 25.
 */
export function gcArgs(javaMajor: number): string[] {
  if (javaMajor <= 8) {
    return [
      '-XX:+UseG1GC',
      '-XX:+UnlockExperimentalVMOptions',
      '-XX:G1NewSizePercent=20',
      '-XX:G1ReservePercent=20',
      '-XX:MaxGCPauseMillis=50',
      '-XX:G1HeapRegionSize=32M'
    ]
  }
  return [
    '-XX:+UseG1GC',
    '-XX:+ParallelRefProcEnabled',
    '-XX:MaxGCPauseMillis=100',
    '-XX:+UnlockExperimentalVMOptions',
    '-XX:+DisableExplicitGC',
    '-XX:G1NewSizePercent=30',
    '-XX:G1MaxNewSizePercent=40',
    '-XX:G1HeapRegionSize=8M',
    '-XX:G1ReservePercent=20',
    '-XX:InitiatingHeapOccupancyPercent=15',
    '-XX:+PerfDisableSharedMem'
  ]
}

/**
 * Memory and GC flags placed ahead of the user's own. Modded launches start
 * with half the heap committed, which avoids a run of resize pauses while
 * hundreds of mods load.
 */
export function tunedJvmArgs(input: {
  javaMajor: number
  ramMb: number
  loader: LoaderType
  userArgs: string
}): string[] {
  const { javaMajor, ramMb, loader, userArgs } = input
  const modded = loader !== 'vanilla'
  const xms = modded ? Math.max(1024, round256(ramMb / 2)) : 1024
  const args = [`-Xmx${ramMb}M`, `-Xms${Math.min(ramMb, xms)}M`]
  if (!hasCustomGc(userArgs)) args.push(...gcArgs(javaMajor))
  return args
}
