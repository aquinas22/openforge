import { spawn, type ChildProcess } from 'node:child_process'
import { basename, dirname, delimiter } from 'node:path'
import type { LocalServerConfig } from '@shared/types'
import { lineSplitter } from './logparse'

/**
 * Running a local server as a child process: stdin for console commands,
 * stdout/stderr split into lines, a graceful "stop" with a kill after a
 * timeout. No Electron imports, so scripts/verify.ts can run it against a fake
 * server.
 */

const SCRIPT = /^[\w.-]+\.(bat|cmd|ps1|sh)$/i
const JAR = /^[^\\/:*?"<>|\0]+\.jar$/i

function splitArgs(value: string): string[] {
  return value.trim() ? value.trim().split(/\s+/) : []
}

export interface LaunchCommand {
  command: string
  args: string[]
  /** Extra environment for the child (a script picks Java up from PATH). */
  env?: Record<string, string>
}

/** The command line for a local server. Throws when the config cannot run here. */
export function buildLocalLaunch(
  cfg: Pick<LocalServerConfig, 'launch' | 'file' | 'ramMb' | 'jvmArgs'>,
  javaPath: string,
  platform: NodeJS.Platform = process.platform
): LaunchCommand {
  const file = basename(String(cfg.file ?? ''))
  if (cfg.launch === 'jar') {
    if (!JAR.test(file)) throw new Error('Pick the server .jar file in this folder.')
    const ram = Math.max(512, Math.round(cfg.ramMb || 2048))
    return {
      command: javaPath || 'java',
      args: [`-Xmx${ram}M`, `-Xms${Math.min(ram, 1024)}M`, ...splitArgs(cfg.jvmArgs ?? ''), '-jar', file, 'nogui']
    }
  }
  if (!SCRIPT.test(file)) throw new Error('Pick the server start script (run.bat, run.sh or start.ps1) in this folder.')
  // Scripts find java on PATH; put the chosen runtime first.
  const env: Record<string, string> | undefined = javaPath && /[\\/]/.test(javaPath)
    ? { PATH: `${dirname(javaPath)}${delimiter}${process.env.PATH ?? process.env.Path ?? ''}` }
    : undefined
  const ext = file.slice(file.lastIndexOf('.') + 1).toLowerCase()
  if (ext === 'bat' || ext === 'cmd') {
    if (platform !== 'win32') throw new Error('Batch files only run on Windows; pick run.sh instead.')
    // ".\" explicitly: with NoDefaultCurrentDirectoryInExePath set (a common
    // hardening), cmd does not look in the current folder for a bare name.
    return { command: 'cmd.exe', args: ['/d', '/c', `.\\${file}`, 'nogui'], env }
  }
  if (ext === 'ps1') {
    return { command: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', `.\\${file}`, 'nogui'], env }
  }
  if (platform === 'win32') throw new Error('Shell scripts need Linux or WSL; pick run.bat on Windows.')
  return { command: 'sh', args: [`./${file}`, 'nogui'], env }
}

export interface ServerProcess {
  readonly pid: number
  readonly running: boolean
  /** Type one console line. Returns false when the server is not running. */
  send(line: string): boolean
  /** Send "stop", wait up to `timeoutMs`, then kill. Resolves once it has exited. */
  stop(timeoutMs: number): Promise<'stopped' | 'killed'>
  /** Kill the process and everything it started, at once. */
  kill(): void
}

export function startServerProcess(opts: {
  command: string
  args: string[]
  cwd: string
  env?: Record<string, string>
  onLine: (stream: 'stdout' | 'stderr', line: string) => void
  onExit: (code: number | null) => void
  onError?: (err: Error) => void
}): ServerProcess {
  const child: ChildProcess = spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    // Own process group on POSIX, so a kill reaches what a script started.
    detached: process.platform !== 'win32'
  })
  let exited = false
  const exitWaiters: (() => void)[] = []

  const send = (line: string): boolean => {
    if (exited || !child.stdin || child.stdin.destroyed) return false
    child.stdin.write(`${line.replace(/[\r\n]+/g, ' ')}\n`)
    return true
  }

  const out = lineSplitter((line) => {
    opts.onLine('stdout', line)
    // A batch file's trailing "pause" would hold the process after the server stopped.
    if (/^Press any key to continue/i.test(line)) send('')
  })
  const err = lineSplitter((line) => opts.onLine('stderr', line))
  child.stdout?.on('data', (d: Buffer) => out.push(d))
  child.stderr?.on('data', (d: Buffer) => err.push(d))
  child.stdin?.on('error', () => undefined) // writes racing an exit
  child.on('error', (e) => {
    opts.onError?.(e)
    if (!exited) {
      exited = true
      opts.onExit(-1)
      exitWaiters.splice(0).forEach((w) => w())
    }
  })
  child.on('close', (code) => {
    if (exited) return
    exited = true
    out.end()
    err.end()
    opts.onExit(code)
    exitWaiters.splice(0).forEach((w) => w())
  })

  const kill = (): void => {
    if (exited || !child.pid) return
    if (process.platform === 'win32') {
      // /T takes the whole tree: cmd.exe, and the java it started.
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () =>
        child.kill()
      )
    } else {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }
  }

  return {
    get pid() {
      return child.pid ?? -1
    },
    get running() {
      return !exited
    },
    send,
    kill,
    stop(timeoutMs) {
      if (exited) return Promise.resolve('stopped')
      return new Promise((resolve) => {
        let killed = false
        const timer = setTimeout(() => {
          killed = true
          kill()
        }, Math.max(0, timeoutMs))
        exitWaiters.push(() => {
          clearTimeout(timer)
          resolve(killed ? 'killed' : 'stopped')
        })
        send('stop')
      })
    }
  }
}
