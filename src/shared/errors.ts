/**
 * Turn failures into a next step. Shared by the main process (crash diagnosis
 * from the game log) and the renderer (a fix button on error toasts).
 */

export type FixAction = 'java' | 'accounts' | 'repair' | 'memory' | 'network' | 'console' | 'content' | 'jvm'

export interface Explanation {
  /** One sentence the player can act on. */
  fix: string
  action?: FixAction
  /** Button text for `action`. */
  actionLabel?: string
}

/** Button text for each fix. */
export const FIX_LABEL: Record<FixAction, string> = {
  java: 'Open Java settings',
  accounts: 'Open accounts',
  repair: 'Repair files',
  memory: 'Adjust memory',
  network: 'Network settings',
  console: 'Open console',
  content: 'Review mods',
  jvm: 'Edit JVM flags'
}

const rule = (pattern: RegExp, fix: string, action?: FixAction): [RegExp, Explanation] => [
  pattern,
  { fix, action, actionLabel: action ? FIX_LABEL[action] : undefined }
]

/** Errors raised while installing or starting. */
const LAUNCH_RULES: [RegExp, Explanation][] = [
  rule(
    /needs Java \d+|No Java runtime|Failed to start Java|spawn .*java.* ENOENT|java(\.exe)? ENOENT/i,
    'Turn on "Manage Java automatically" or install the matching runtime from Settings.',
    'java'
  ),
  rule(/Add an account|No account selected/i, 'Add a Microsoft account or an offline profile, then press Play again.', 'accounts'),
  rule(/sign in to Microsoft again|reauth/i, 'Sign in to Microsoft again from the account menu.', 'accounts'),
  rule(/does not own Minecraft|entitle/i, 'This Microsoft account has no Java Edition licence. Use an offline profile or another account.', 'accounts'),
  rule(/trusted HTTPS connection|certificate/i, 'Your network is intercepting HTTPS. Settings -> Network explains the fix.', 'network'),
  rule(/ENOTFOUND|ECONNRESET|ETIMEDOUT|fetch failed|network/i, 'Check your internet connection, then try again. Installed profiles still launch offline.', 'network'),
  rule(/ENOSPC|no space left/i, 'The disk is full. Free some space, or move the game folder in Settings.'),
  rule(/EPERM|EBUSY|EACCES|operation not permitted|resource busy/i, 'A file is locked. Close Minecraft and any other launcher, then try again.'),
  rule(/installer exited|did not produce|corrupt file|sha1 mismatch|LWJGL|missing/i, 'Run "Verify and repair files" for this profile.', 'repair'),
  rule(/already running/i, 'Stop the running game first, or switch to it.', 'console')
]

/** Suggest a fix for an install or launch error message. */
export function explainError(message: string): Explanation | null {
  for (const [pattern, explanation] of LAUNCH_RULES) if (pattern.test(message)) return explanation
  return null
}

export interface CrashDiagnosis extends Explanation {
  /** Short title for the error toast. */
  title: string
}

const CRASH_RULES: [RegExp, CrashDiagnosis][] = [
  [
    /ClassLoaders\$AppClassLoader cannot be cast to (class )?java\.net\.URLClassLoader/,
    { title: 'Java is too new for this Forge version', fix: 'Old Forge needs Java 8. Set the profile to Java 8 or enable managed Java.', action: 'java', actionLabel: FIX_LABEL.java }
  ],
  [
    /UnsupportedClassVersionError|compiled by a more recent version of the Java Runtime|has been compiled by a more recent version/,
    { title: 'A mod needs a newer Java', fix: 'Clear the profile\'s Java override so the managed runtime is used, or install a newer Java.', action: 'java', actionLabel: FIX_LABEL.java }
  ],
  [
    /Could not reserve enough space|Invalid maximum heap size|There is insufficient memory for the Java Runtime/,
    { title: 'Java could not reserve the memory', fix: 'Lower this profile\'s memory, or close other programs.', action: 'memory', actionLabel: FIX_LABEL.memory }
  ],
  [
    /OutOfMemoryError/,
    { title: 'Minecraft ran out of memory', fix: 'Give this profile more memory (6-8 GB suits most modpacks).', action: 'memory', actionLabel: FIX_LABEL.memory }
  ],
  [
    /Unrecognized VM option|Could not create the Java Virtual Machine|Unrecognized option/,
    { title: 'A JVM flag was rejected', fix: 'Remove the unsupported flag from the profile\'s extra JVM flags.', action: 'jvm', actionLabel: FIX_LABEL.jvm }
  ],
  [
    /Missing or unsupported mandatory dependencies|requires .* (?:but|which is missing)|Mod resolution failed|Incompatible mods? found|depends on .* which is missing/i,
    { title: 'A mod is missing a dependency', fix: 'Open the console to see which mod, then add the dependency or remove the mod.', action: 'console', actionLabel: FIX_LABEL.console }
  ],
  [
    /Found duplicate mods|Duplicate mods? found|DuplicateModsFoundException|is already loaded/i,
    { title: 'The same mod is installed twice', fix: 'Remove the older copy from the Mods list.', action: 'content', actionLabel: FIX_LABEL.content }
  ],
  [
    /Mixin apply .* failed|MixinApplyError|InvalidInjectionException|MixinTransformerError/,
    { title: 'Two mods are incompatible', fix: 'The console names the mod whose mixin failed. Update or disable it.', action: 'console', actionLabel: FIX_LABEL.console }
  ],
  [
    /ResolutionException|reads package .* from both|Module .* reads more than one module/,
    { title: 'Conflicting library copies', fix: 'Run "Verify and repair files". If it persists, a mod bundles a library twice.', action: 'repair', actionLabel: FIX_LABEL.repair }
  ],
  [
    /Pixel format not accelerated|GLFW error 65542|WGL: The driver does not appear to support OpenGL|OpenGL 3\.2/,
    { title: 'Your graphics driver cannot run Minecraft', fix: 'Update your graphics driver from the GPU maker\'s site.' }
  ]
]

/** Find the likeliest cause of a crash in the last lines the game printed. */
export function diagnoseCrash(lines: string[]): CrashDiagnosis | null {
  const text = lines.join('\n')
  for (const [pattern, diagnosis] of CRASH_RULES) if (pattern.test(text)) return diagnosis
  return null
}
