import type { KeyBinding, KeyBindingReport, KeyConflict } from '../../shared/types'

/**
 * Reading and resetting key bindings in a Minecraft `options.txt`.
 *
 * Every line is `name:value`. Key bindings are `key_<binding id>:<key>`, where
 * the key is a modern token (`key.keyboard.space`, `key.mouse.left`) or, before
 * 1.13, an LWJGL 2 key code (`57`, `-100` for mouse buttons). Forge and
 * NeoForge append a modifier: `key_key.jei.showRecipe:key.keyboard.r:SHIFT`.
 *
 * Everything here is pure text in, text out, so it is covered by the
 * verification suite without a game install.
 */

/** Vanilla defaults for modern (1.13+) versions. */
export const VANILLA_KEY_DEFAULTS: Record<string, string> = {
  'key.attack': 'key.mouse.left',
  'key.use': 'key.mouse.right',
  'key.forward': 'key.keyboard.w',
  'key.left': 'key.keyboard.a',
  'key.back': 'key.keyboard.s',
  'key.right': 'key.keyboard.d',
  'key.jump': 'key.keyboard.space',
  'key.sneak': 'key.keyboard.left.shift',
  'key.sprint': 'key.keyboard.left.control',
  'key.drop': 'key.keyboard.q',
  'key.inventory': 'key.keyboard.e',
  'key.chat': 'key.keyboard.t',
  'key.playerlist': 'key.keyboard.tab',
  'key.pickItem': 'key.mouse.middle',
  'key.command': 'key.keyboard.slash',
  'key.socialInteractions': 'key.keyboard.p',
  'key.screenshot': 'key.keyboard.f2',
  'key.togglePerspective': 'key.keyboard.f5',
  'key.smoothCamera': 'key.keyboard.unknown',
  'key.fullscreen': 'key.keyboard.f11',
  'key.spectatorOutlines': 'key.keyboard.unknown',
  'key.swapOffhand': 'key.keyboard.f',
  'key.saveToolbarActivator': 'key.keyboard.c',
  'key.loadToolbarActivator': 'key.keyboard.x',
  'key.advancements': 'key.keyboard.l',
  'key.hotbar.1': 'key.keyboard.1',
  'key.hotbar.2': 'key.keyboard.2',
  'key.hotbar.3': 'key.keyboard.3',
  'key.hotbar.4': 'key.keyboard.4',
  'key.hotbar.5': 'key.keyboard.5',
  'key.hotbar.6': 'key.keyboard.6',
  'key.hotbar.7': 'key.keyboard.7',
  'key.hotbar.8': 'key.keyboard.8',
  'key.hotbar.9': 'key.keyboard.9'
}

const VANILLA_LABELS: Record<string, [label: string, category: string]> = {
  'key.attack': ['Attack / Destroy', 'Gameplay'],
  'key.use': ['Use Item / Place Block', 'Gameplay'],
  'key.pickItem': ['Pick Block', 'Gameplay'],
  'key.forward': ['Walk Forwards', 'Movement'],
  'key.left': ['Strafe Left', 'Movement'],
  'key.back': ['Walk Backwards', 'Movement'],
  'key.right': ['Strafe Right', 'Movement'],
  'key.jump': ['Jump', 'Movement'],
  'key.sneak': ['Sneak', 'Movement'],
  'key.sprint': ['Sprint', 'Movement'],
  'key.drop': ['Drop Selected Item', 'Inventory'],
  'key.inventory': ['Open/Close Inventory', 'Inventory'],
  'key.swapOffhand': ['Swap Item With Offhand', 'Inventory'],
  'key.chat': ['Open Chat', 'Multiplayer'],
  'key.playerlist': ['List Players', 'Multiplayer'],
  'key.command': ['Open Command', 'Multiplayer'],
  'key.socialInteractions': ['Social Interactions', 'Multiplayer'],
  'key.screenshot': ['Take Screenshot', 'Miscellaneous'],
  'key.togglePerspective': ['Toggle Perspective', 'Miscellaneous'],
  'key.smoothCamera': ['Toggle Cinematic Camera', 'Miscellaneous'],
  'key.fullscreen': ['Toggle Fullscreen', 'Miscellaneous'],
  'key.spectatorOutlines': ['Highlight Players (Spectators)', 'Miscellaneous'],
  'key.advancements': ['Advancements', 'Miscellaneous'],
  'key.saveToolbarActivator': ['Save Hotbar Activator', 'Creative'],
  'key.loadToolbarActivator': ['Load Hotbar Activator', 'Creative']
}

/** LWJGL 2 key codes used by options.txt before 1.13. */
const LEGACY_CODES: Record<string, string> = {
  '-100': 'Left Click',
  '-99': 'Right Click',
  '-98': 'Middle Click',
  '0': 'Not bound',
  '1': 'Escape',
  '14': 'Backspace',
  '15': 'Tab',
  '28': 'Enter',
  '29': 'Left Ctrl',
  '41': '`',
  '42': 'Left Shift',
  '43': '\\',
  '53': '/',
  '54': 'Right Shift',
  '56': 'Left Alt',
  '57': 'Space',
  '58': 'Caps Lock',
  '87': 'F11',
  '88': 'F12',
  '157': 'Right Ctrl',
  '184': 'Right Alt',
  '200': 'Up',
  '203': 'Left',
  '205': 'Right',
  '208': 'Down'
}
'1234567890'.split('').forEach((digit, i) => (LEGACY_CODES[String(i + 2)] = digit))
'QWERTYUIOP'.split('').forEach((letter, i) => (LEGACY_CODES[String(i + 16)] = letter))
'ASDFGHJKL'.split('').forEach((letter, i) => (LEGACY_CODES[String(i + 30)] = letter))
'ZXCVBNM'.split('').forEach((letter, i) => (LEGACY_CODES[String(i + 44)] = letter))
for (let i = 1; i <= 10; i++) LEGACY_CODES[String(58 + i)] = `F${i}`

const SPECIAL_KEYS: Record<string, string> = {
  unknown: 'Not bound',
  space: 'Space',
  tab: 'Tab',
  enter: 'Enter',
  escape: 'Escape',
  backspace: 'Backspace',
  'caps.lock': 'Caps Lock',
  'grave.accent': '`',
  slash: '/',
  backslash: '\\',
  minus: '-',
  equal: '=',
  comma: ',',
  period: '.',
  semicolon: ';',
  apostrophe: "'",
  'left.bracket': '[',
  'right.bracket': ']',
  'page.up': 'Page Up',
  'page.down': 'Page Down',
  'num.lock': 'Num Lock',
  'scroll.lock': 'Scroll Lock',
  'print.screen': 'Print Screen',
  'left.win': 'Left Windows',
  'right.win': 'Right Windows',
  menu: 'Menu'
}

const titleCase = (text: string): string =>
  text
    .split(/[\s._-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')

/** A key token as a person would name it: `key.keyboard.left.shift` -> "Left Shift". */
export function friendlyKeyName(token: string): string {
  if (/^-?\d+$/.test(token)) return LEGACY_CODES[token] ?? `Key ${token}`
  if (token.startsWith('key.mouse.')) {
    const button = token.slice('key.mouse.'.length)
    if (button === 'left') return 'Left Click'
    if (button === 'right') return 'Right Click'
    if (button === 'middle') return 'Middle Click'
    return `Mouse ${button}`
  }
  if (token.startsWith('key.keyboard.')) {
    const key = token.slice('key.keyboard.'.length)
    if (SPECIAL_KEYS[key]) return SPECIAL_KEYS[key]
    if (/^f\d{1,2}$/.test(key)) return key.toUpperCase()
    if (/^[a-z0-9]$/.test(key)) return key.toUpperCase()
    if (key.startsWith('keypad.')) {
      const rest = key.slice('keypad.'.length)
      const ops: Record<string, string> = { add: '+', subtract: '-', multiply: '*', divide: '/', decimal: '.', enter: 'Enter', equal: '=' }
      return `Numpad ${ops[rest] ?? rest.toUpperCase()}`
    }
    if (/^(left|right)\.(shift|control|alt)$/.test(key)) {
      const [side, mod] = key.split('.')
      return `${titleCase(side)} ${mod === 'control' ? 'Ctrl' : titleCase(mod)}`
    }
    return titleCase(key)
  }
  return token
}

const MODIFIER_LABEL: Record<string, string> = { SHIFT: 'Shift', CONTROL: 'Ctrl', ALT: 'Alt' }

/** Human label + group for a binding id. Unknown (modded) ids are prettified. */
export function describeBinding(id: string): { label: string; category: string; vanilla: boolean } {
  const known = VANILLA_LABELS[id]
  if (known) return { label: known[0], category: known[1], vanilla: true }
  const hotbar = id.match(/^key\.hotbar\.(\d)$/)
  if (hotbar) return { label: `Hotbar Slot ${hotbar[1]}`, category: 'Inventory', vanilla: true }
  // Mods name bindings `key.<modid>.<action>` or `<modid>.key.<action>`.
  const parts = id.replace(/^key\./, '').split('.').filter((part) => part !== 'key')
  const namespace = parts.length > 1 ? parts[0] : 'Other'
  const action = parts.length > 1 ? parts.slice(1).join(' ') : parts[0] ?? id
  const spaced = action.replace(/([a-z])([A-Z])/g, '$1 $2')
  return { label: titleCase(spaced), category: namespace, vanilla: false }
}

interface OptionLine {
  name: string
  value: string
}

/** Split options.txt into name/value pairs on the first colon. */
export function parseOptions(text: string): OptionLine[] {
  const out: OptionLine[] = []
  for (const raw of text.split(/\r?\n/)) {
    const idx = raw.indexOf(':')
    if (idx <= 0) continue
    out.push({ name: raw.slice(0, idx), value: raw.slice(idx + 1) })
  }
  return out
}

/** The key part of a binding value, and its Forge modifier if any. */
function splitBindingValue(value: string): { key: string; modifier?: string } {
  const match = value.match(/^(.*?):(SHIFT|CONTROL|ALT|NONE)$/)
  if (!match) return { key: value }
  return { key: match[1], modifier: match[2] === 'NONE' ? undefined : match[2] }
}

function isUnbound(key: string): boolean {
  return key === 'key.keyboard.unknown' || key === '0' || key === ''
}

/** Group bindings that fire from the same key (and modifier). Unbound keys never conflict. */
export function findConflicts(bindings: Pick<KeyBinding, 'id' | 'key' | 'modifier' | 'keyLabel'>[]): KeyConflict[] {
  const groups = new Map<string, { key: string; keyLabel: string; ids: string[] }>()
  for (const binding of bindings) {
    if (isUnbound(binding.key)) continue
    const signature = `${binding.key}|${binding.modifier ?? ''}`
    const label = binding.modifier ? `${MODIFIER_LABEL[binding.modifier] ?? binding.modifier} + ${binding.keyLabel}` : binding.keyLabel
    const group = groups.get(signature) ?? { key: signature, keyLabel: label, ids: [] }
    group.ids.push(binding.id)
    groups.set(signature, group)
  }
  return [...groups.values()].filter((group) => group.ids.length > 1)
}

/** Every key binding in an options.txt, labelled, with defaults and conflicts marked. */
export function readKeyBindings(text: string | null): KeyBindingReport {
  if (text === null) return { exists: false, legacy: false, bindings: [], conflicts: [] }
  const rows = parseOptions(text).filter((line) => line.name.startsWith('key_'))
  const legacy = rows.some((row) => /^-?\d+$/.test(splitBindingValue(row.value).key))
  const bindings: KeyBinding[] = rows.map((row) => {
    const id = row.name.slice(4)
    const { key, modifier } = splitBindingValue(row.value)
    const info = describeBinding(id)
    const defaultKey = legacy ? undefined : VANILLA_KEY_DEFAULTS[id]
    const keyLabel = friendlyKeyName(key)
    return {
      id,
      label: info.label,
      category: info.category,
      vanilla: info.vanilla,
      key,
      keyLabel: modifier ? `${MODIFIER_LABEL[modifier] ?? modifier} + ${keyLabel}` : keyLabel,
      modifier,
      defaultKey,
      defaultLabel: defaultKey ? friendlyKeyName(defaultKey) : undefined,
      isDefault: defaultKey ? defaultKey === key && !modifier : false,
      conflict: false
    }
  })
  const conflicts = findConflicts(
    bindings.map((binding) => ({ ...binding, keyLabel: friendlyKeyName(binding.key) }))
  )
  const clashing = new Set(conflicts.flatMap((conflict) => conflict.ids))
  for (const binding of bindings) binding.conflict = clashing.has(binding.id)
  return { exists: true, legacy, bindings, conflicts }
}

/**
 * Reset bindings (all of them when `ids` is null). Vanilla bindings in a modern
 * file are written back to their default key, so the table still shows them;
 * anything else is removed, and the game restores the mod's own default the
 * next time it starts. Every other line is kept byte for byte.
 */
export function resetKeyBindings(text: string, ids: string[] | null): string {
  const legacy = readKeyBindings(text).legacy
  const wanted = ids ? new Set(ids) : null
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const out: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    const idx = raw.indexOf(':')
    const name = idx > 0 ? raw.slice(0, idx) : ''
    if (!name.startsWith('key_')) {
      out.push(raw)
      continue
    }
    const id = name.slice(4)
    if (wanted && !wanted.has(id)) {
      out.push(raw)
      continue
    }
    const fallback = legacy ? undefined : VANILLA_KEY_DEFAULTS[id]
    if (fallback) out.push(`${name}:${fallback}`)
    // otherwise drop the line: the game writes the default back on next start
  }
  return out.join(eol)
}
