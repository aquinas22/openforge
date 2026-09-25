/**
 * Reading a Minecraft server's console. Pure, and tested by scripts/verify.ts.
 *
 * Only the text after the logger prefix is matched, and names must be valid
 * Minecraft names, so chat cannot fake events: "<Steve> Bob joined the game"
 * and "[Server] Bob joined the game" (from /say) are ignored.
 */

export type ServerLogEvent =
  | { type: 'done'; seconds?: number }
  | { type: 'join'; name: string }
  | { type: 'leave'; name: string }
  | { type: 'list'; online: number; max: number; names?: string[] }
  | { type: 'stopping' }

const NAME = '[A-Za-z0-9_]{1,16}'

/**
 * The message part of a log line. Vanilla "[12:00:00] [Server thread/INFO]: ",
 * Forge "[..] [..] [minecraft/DedicatedServer]: ", and Paper "[12:00:00 INFO]: "
 * all end their prefix with "]: ". Lines without one are taken whole.
 */
export function logMessage(line: string): string {
  const clean = line.replace(/\x1b\[[0-9;]*m/g, '').trimEnd()
  const cut = clean.indexOf(']: ')
  return cut >= 0 ? clean.slice(cut + 3) : clean.trim()
}

export function parseServerLogLine(line: string): ServerLogEvent | null {
  const message = logMessage(line)
  let m = /^Done \((\d+(?:[.,]\d+)?)s\)! For help, type/.exec(message)
  if (m) return { type: 'done', seconds: Number(m[1].replace(',', '.')) }
  if (/^Done! For help, type/.test(message)) return { type: 'done' }
  m = new RegExp(`^(${NAME}) joined the game$`).exec(message)
  if (m) return { type: 'join', name: m[1] }
  m = new RegExp(`^(${NAME}) left the game$`).exec(message)
  if (m) return { type: 'leave', name: m[1] }
  // 1.13+: "There are 2 of a max of 20 players online: Alex, Steve"
  m = /^There are (\d+) of a max(?: of)? (\d+) players online:?\s*(.*)$/.exec(message)
  if (m) {
    const names = m[3]
      .split(',')
      .map((n) => n.trim())
      .filter((n) => new RegExp(`^${NAME}$`).test(n))
    return { type: 'list', online: Number(m[1]), max: Number(m[2]), names }
  }
  // Older servers: "There are 2/20 players online:" (names follow on the next line).
  m = /^There are (\d+)\/(\d+) players online:?$/.exec(message)
  if (m) return { type: 'list', online: Number(m[1]), max: Number(m[2]) }
  if (/^Stopping (the )?server$/.test(message)) return { type: 'stopping' }
  return null
}

/** Players online, kept up to date from log events. */
export class PlayerTracker {
  private names = new Set<string>()
  private count: number | null = null
  max?: number
  ready = false
  doneSeconds?: number

  /** Apply one log line; returns the event it contained, if any. */
  feed(line: string): ServerLogEvent | null {
    const event = parseServerLogLine(line)
    if (!event) return null
    switch (event.type) {
      case 'done':
        this.ready = true
        this.doneSeconds = event.seconds
        break
      case 'join':
        this.names.add(event.name)
        this.count = null
        break
      case 'leave':
        this.names.delete(event.name)
        this.count = null
        break
      case 'list':
        this.max = event.max
        if (event.names) {
          this.names = new Set(event.names)
          this.count = null
        } else {
          this.count = event.online
        }
        break
      case 'stopping':
        this.ready = false
        break
    }
    return event
  }

  reset(): void {
    this.names.clear()
    this.count = null
    this.max = undefined
    this.ready = false
    this.doneSeconds = undefined
  }

  get snapshot(): { online: number; max?: number; names: string[] } {
    const names = [...this.names].sort((a, b) => a.localeCompare(b))
    return { online: this.count ?? names.length, max: this.max, names }
  }
}

/** Split a byte stream into lines, carrying partial lines between chunks. */
export function lineSplitter(onLine: (line: string) => void): { push: (chunk: Buffer | string) => void; end: () => void } {
  let carry = ''
  return {
    push(chunk) {
      const text = carry + chunk.toString()
      const parts = text.split(/\r?\n/)
      carry = parts.pop() ?? ''
      for (const part of parts) if (part.length) onLine(part.replace(/\r$/, ''))
    },
    end() {
      if (carry.length) onLine(carry)
      carry = ''
    }
  }
}
