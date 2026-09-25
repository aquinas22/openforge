import type { SshServerConfig } from './types'

/**
 * Building ssh invocations safely. Pure functions, shared by the main process
 * (which runs them) and the renderer (which previews the default commands),
 * and tested directly by scripts/verify.ts.
 *
 * Two layers of safety:
 *  - Locally, nothing goes through a shell: ssh gets an argv array, and the
 *    host, user, port and key path are validated first, so none of them can
 *    smuggle in an ssh option (a host of "-oProxyCommand=..." is refused, and
 *    "--" ends option parsing before the host anyway).
 *  - Remotely, ssh hands one command string to the user's login shell. Every
 *    value Openforge interpolates into it (session name, unit, directory, log
 *    path, the console command being sent) is single-quoted for a POSIX shell.
 *    Commands the user typed into the override fields are theirs and run as
 *    written.
 */

/** Single-quote for a POSIX shell: 'it'\''s' - safe for any byte but NUL. */
export function shQuote(value: string): string {
  if (value.includes('\0')) throw new Error('Values cannot contain NUL bytes.')
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * Quote a remote path, keeping a leading "~/" meaning the remote home folder
 * (a quoted "~" would not expand).
 */
export function remotePath(path: string): string {
  const p = path.trim()
  if (p === '~' || p === '') return '"$HOME"'
  if (p.startsWith('~/')) return `"$HOME"/${shQuote(p.slice(2))}`
  return shQuote(p)
}

const HOSTNAME = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.?$/
const IPV6 = /^[0-9A-Fa-f:.]{2,45}$/
const USER = /^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/

export interface SshTarget {
  host: string
  port: number
  user: string
  /** Private key file; empty uses ssh-agent and the default keys. */
  identityFile: string
}

/** Throw a readable error when the connection details are unsafe or malformed. */
export function validateSshTarget(target: SshTarget): void {
  const host = String(target.host ?? '').trim()
  if (!host) throw new Error('Enter the server host name or IP address.')
  if (host.startsWith('-') || !(HOSTNAME.test(host) || (host.includes(':') && IPV6.test(host)))) {
    throw new Error(`"${host}" is not a valid host name or IP address.`)
  }
  if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535) {
    throw new Error('The SSH port must be a whole number from 1 to 65535.')
  }
  if (!USER.test(String(target.user ?? ''))) {
    throw new Error('The SSH user may use letters, digits, "_", "." and "-", and must not start with a digit or "-".')
  }
  const key = String(target.identityFile ?? '')
  if (key && (key.startsWith('-') || /[\0\r\n]/.test(key))) {
    throw new Error('That key file path cannot be used.')
  }
}

/** Session and unit names are quoted, but must still be sane names. */
export function validateRemoteName(value: string, what: string): void {
  if (!value || value.length > 100 || /[\0-\x1f\x7f]/.test(value)) {
    throw new Error(`The ${what} must be 1-100 characters with no control characters.`)
  }
}

export interface SshOptions {
  /** Seconds to wait for the TCP connection and handshake. */
  connectTimeout?: number
  /** Allocate no terminal (the default); streaming commands still work. */
  tty?: boolean
}

/**
 * The argv for one ssh run. BatchMode makes ssh fail instead of prompting for
 * a password or passphrase (Openforge never stores passwords), and
 * accept-new trusts a server on first contact but refuses a changed key.
 */
export function buildSshArgs(target: SshTarget, remoteCommand: string, options: SshOptions = {}): string[] {
  validateSshTarget(target)
  const timeout = Math.min(120, Math.max(1, Math.round(options.connectTimeout ?? 10)))
  const args = [
    '-o', 'BatchMode=yes',
    '-o', `ConnectTimeout=${timeout}`,
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-p', String(target.port)
  ]
  if (target.identityFile) args.push('-i', target.identityFile, '-o', 'IdentitiesOnly=yes')
  args.push('-l', target.user, options.tty ? '-t' : '-T', '--', target.host.trim(), remoteCommand)
  return args
}

/** Escape text for screen's `stuff` command, which expands ^X, \ and $ itself. */
function screenStuff(text: string): string {
  return text.replace(/[\\^$]/g, (c) => `\\${c}`)
}

export interface RemoteCommands {
  start: string
  stop: string
  status: string
  /** The console command to type into the server. */
  send: (command: string) => string | null
  tail: string
}

/** The preset commands for tmux, screen, or systemd, before any overrides. */
export function presetCommands(cfg: SshServerConfig): RemoteCommands {
  const session = shQuote(cfg.session || 'mc')
  const dir = remotePath(cfg.serverDir || '~/server')
  const script = cfg.startScript?.trim() || './run.sh'
  const log = cfg.logPath?.trim() || 'logs/latest.log'
  const tailFile = log.startsWith('/') || log.startsWith('~')
    ? `tail -n 200 -F -- ${remotePath(log)}`
    : `cd ${dir} && tail -n 200 -F -- ${shQuote(log)}`

  switch (cfg.control) {
    case 'screen':
      return {
        start: `screen -dmS ${session} sh -c ${shQuote(`cd ${dir} && ${script}`)}`,
        stop: `screen -S ${session} -p 0 -X stuff ${shQuote('stop^M')}`,
        status: `screen -ls | S=${session} awk '{ p = index($1, "."); if (p && substr($1, p + 1) == ENVIRON["S"]) f = 1 } END { exit !f }'`,
        send: (command) => `screen -S ${session} -p 0 -X stuff ${shQuote(`${screenStuff(command)}^M`)}`,
        tail: tailFile
      }
    case 'systemd': {
      const unit = shQuote(cfg.unit || 'minecraft')
      return {
        // -n: fail at once instead of waiting for a sudo password.
        start: `sudo -n systemctl start -- ${unit}`,
        stop: `sudo -n systemctl stop -- ${unit}`,
        status: `systemctl is-active --quiet -- ${unit}`,
        // A systemd unit has no console to type into; needs a custom send command.
        send: () => null,
        tail: cfg.logPath?.trim() ? tailFile : `journalctl -u ${unit} -n 200 -f -o cat`
      }
    }
    default:
      return {
        start: `tmux new-session -d -s ${session} ${shQuote(`cd ${dir} && ${script}`)}`,
        stop: `tmux send-keys -t ${session} stop Enter`,
        status: `tmux has-session -t ${session}`,
        // -l types the text literally, so key names in it are not interpreted.
        send: (command) => `tmux send-keys -t ${session} -l -- ${shQuote(command)} && tmux send-keys -t ${session} Enter`,
        tail: tailFile
      }
  }
}

/** The commands actually run: the user's overrides where set, else the preset. */
export function effectiveCommands(cfg: SshServerConfig): RemoteCommands {
  const preset = presetCommands(cfg)
  const own = (value: string | undefined): string | null => (value && value.trim() ? value.trim() : null)
  const sendTemplate = own(cfg.sendCommand)
  return {
    start: own(cfg.startCommand) ?? preset.start,
    stop: own(cfg.stopCommand) ?? preset.stop,
    status: own(cfg.statusCommand) ?? preset.status,
    send: sendTemplate
      ? (command) =>
          sendTemplate.includes('{cmd}')
            ? sendTemplate.split('{cmd}').join(shQuote(command))
            : `${sendTemplate} ${shQuote(command)}`
      : preset.send,
    tail: own(cfg.tailCommand) ?? preset.tail
  }
}

export type SshFailure = 'timeout' | 'dns' | 'refused' | 'hostkey' | 'auth' | 'key' | 'missing-ssh' | 'other'

/** Turn ssh's stderr into something a player can act on. */
export function classifySshError(stderr: string, exitCode: number | null, timedOut = false): { kind: SshFailure; message: string } {
  const text = stderr || ''
  if (/ENOENT|is not recognized|No such file or directory.*ssh(\.exe)?$/im.test(text) && exitCode === -1) {
    return { kind: 'missing-ssh', message: 'The Windows OpenSSH client (ssh.exe) was not found. Add it under Settings > Apps > Optional features.' }
  }
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed|host key for .* has changed/i.test(text)) {
    return {
      kind: 'hostkey',
      message:
        "The server's host key does not match the one this PC saw before. If you reinstalled the server, remove the old entry with ssh-keygen -R <host>; otherwise do not connect."
    }
  }
  if (/Could not resolve hostname|Name or service not known|nodename nor servname|No such host is known/i.test(text)) {
    return { kind: 'dns', message: 'That host name could not be found. Check the spelling, or use the IP address.' }
  }
  if (/Connection refused/i.test(text)) {
    return { kind: 'refused', message: 'The server refused the connection. Check the port, and that the SSH service is running.' }
  }
  if (timedOut || /timed out|Connection timed out|Operation timed out/i.test(text)) {
    return { kind: 'timeout', message: 'The server did not answer in time. Check the host, the port, and any firewall in between.' }
  }
  if (/Load key .*(bad permissions|invalid format|No such file|error in libcrypto)|no such identity|UNPROTECTED PRIVATE KEY|incorrect passphrase/i.test(text)) {
    return {
      kind: 'key',
      message:
        'The key file could not be used. Check the path, and if the key has a passphrase, load it into ssh-agent (ssh-add) instead.'
    }
  }
  if (/Permission denied|Too many authentication failures|Authentication failed|no mutual signature/i.test(text)) {
    return {
      kind: 'auth',
      message:
        'The server refused the login. Check the user name and that this key is in ~/.ssh/authorized_keys on the server (ssh-agent: ssh-add -l lists loaded keys).'
    }
  }
  const last = text.trim().split(/\r?\n/).filter(Boolean).pop()
  return { kind: 'other', message: last ? `ssh failed: ${last}` : `ssh exited with code ${exitCode ?? 'unknown'}.` }
}
