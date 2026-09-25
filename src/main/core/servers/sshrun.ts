import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { lineSplitter } from './logparse'

/**
 * Running the system OpenSSH client. Arguments always go to spawn() as an
 * array with no shell, so nothing here is ever parsed by a local shell; build
 * them with shared/ssh.ts, which validates and quotes.
 */

/** The Windows OpenSSH client when present, else whatever `ssh` is on PATH. */
export function sshExecutable(): string {
  if (process.platform === 'win32') {
    const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
    const bundled = join(root, 'System32', 'OpenSSH', 'ssh.exe')
    if (existsSync(bundled)) return bundled
    return 'ssh.exe'
  }
  return 'ssh'
}

export interface SshRun {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

/** Run one ssh command to completion (or until `timeoutMs`). */
export function runSsh(args: string[], timeoutMs: number): Promise<SshRun> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let done = false
    const child = spawn(sshExecutable(), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)
    const finish = (code: number | null): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ code, stdout: stdout.slice(-200_000), stderr: stderr.slice(-50_000), timedOut })
    }
    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()))
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()))
    child.on('error', (err) => {
      stderr += `${(err as NodeJS.ErrnoException).code ?? ''} ${err.message}`
      finish(-1)
    })
    child.on('close', (code) => finish(code))
  })
}

/** Stream a long-running ssh command (a log tail) line by line. */
export function streamSsh(
  args: string[],
  onLine: (stream: 'stdout' | 'stderr', line: string) => void,
  onExit: (code: number | null, stderr: string) => void
): { stop: () => void } {
  let stderrTail = ''
  let ended = false
  const child = spawn(sshExecutable(), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const out = lineSplitter((line) => onLine('stdout', line))
  const err = lineSplitter((line) => {
    stderrTail = `${stderrTail}\n${line}`.slice(-4000)
    onLine('stderr', line)
  })
  child.stdout?.on('data', (d: Buffer) => out.push(d))
  child.stderr?.on('data', (d: Buffer) => err.push(d))
  const end = (code: number | null): void => {
    if (ended) return
    ended = true
    out.end()
    err.end()
    onExit(code, stderrTail)
  }
  child.on('error', (e) => {
    stderrTail += `\n${(e as NodeJS.ErrnoException).code ?? ''} ${e.message}`
    end(-1)
  })
  child.on('close', (code) => end(code))
  return { stop: () => child.kill() }
}
