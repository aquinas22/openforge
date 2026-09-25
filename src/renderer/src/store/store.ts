import { create } from 'zustand'
import type {
  AccountSummary,
  ContentKind,
  Instance,
  JavaInfo,
  JavaRuntimeStatus,
  LogLine,
  ProgressEvent,
  Settings,
  SystemInfo,
  VersionSummary
} from '@shared/types'
import type { CreateInstanceInput, PackInstallInput, PlayStatus, ProviderStatus, QuickPlayInput } from '@shared/ipc'
import { explainError, FIX_LABEL, type FixAction } from '@shared/errors'
import { api } from '../api'
import { cleanError } from '../util'

export type Route = 'library' | 'discover' | 'settings'
export type DetailTab = 'overview' | 'setup' | 'worlds' | 'manage'
/** The instance editor's tabs: one per content kind, then the profile's settings. */
export type EditorTab = 'mod' | 'resourcepack' | 'shader' | 'datapack' | 'settings'

export interface Toast {
  id: number
  kind: 'info' | 'success' | 'error'
  message: string
  /** Bold first line, used for errors that come with a separate fix. */
  title?: string
  action?: { label: string; fix: FixAction; instanceId?: string }
}

export interface ToastOptions {
  title?: string
  action?: Toast['action']
  /** Explain the message and offer a fix button when a known cause matches. */
  explain?: boolean
  instanceId?: string
}

interface State {
  ready: boolean
  route: Route
  settings: Settings | null
  systemInfo: SystemInfo | null
  accounts: AccountSummary[]
  instances: Instance[]
  java: JavaInfo[]
  javaRuntimes: JavaRuntimeStatus[]
  versions: VersionSummary[]
  latest: { release: string; snapshot: string }
  providers: ProviderStatus

  progress: Record<string, ProgressEvent>
  busy: Record<string, boolean>
  running: Record<string, boolean>
  logs: Record<string, LogLine[]>

  consoleFor: string | null
  detailInstance: string | null
  /** Which drawer tab to show when the detail opens. */
  detailTab: DetailTab
  /** The instance open in the editor, and which tab. */
  editorFor: string | null
  editorTab: EditorTab
  accountsOpen: boolean
  shortcutsOpen: boolean
  browseTarget: { instanceId: string; kind: ContentKind } | null
  /** A Settings section to open and scroll to on the next visit. */
  settingsAnchor: 'advanced' | null
  toasts: Toast[]

  /** Offline-play gate and official launcher detection; null until first checked. */
  playStatus: PlayStatus | null

  init(): Promise<void>
  setRoute(r: Route): void
  toast(message: string, kind?: Toast['kind'], options?: ToastOptions): void
  dismissToast(id: number): void
  /** Carry out the fix offered on an error toast. */
  runFix(fix: FixAction, instanceId?: string): void
  setAccountsOpen(open: boolean): void
  setShortcutsOpen(open: boolean): void
  setDetailTab(tab: DetailTab): void
  clearSettingsAnchor(): void

  refreshInstances(): Promise<void>
  refreshAccounts(): Promise<void>
  saveSettings(patch: Partial<Settings>): Promise<void>
  refreshJava(): Promise<void>

  addOfflineAccount(username: string): Promise<void>
  setActiveAccount(id: string): Promise<void>
  removeAccount(id: string): Promise<void>
  refreshPlayStatus(): Promise<void>
  openOfficialLauncher(): Promise<void>

  createInstance(input: CreateInstanceInput): Promise<void>
  deleteInstance(id: string): Promise<void>
  duplicateInstance(id: string): Promise<void>
  launch(id: string, quickPlay?: QuickPlayInput): Promise<void>
  install(id: string): Promise<void>
  repair(id: string): Promise<void>
  kill(id: string): Promise<void>
  installPack(input: PackInstallInput): Promise<void>
  importPack(): Promise<void>
  updatePack(id: string): Promise<void>

  openConsole(id: string | null): void
  openDetail(id: string | null, tab?: DetailTab): void
  openEditor(id: string | null, tab?: EditorTab): void
  browseFor(instanceId: string, kind: ContentKind): void
}

let toastSeq = 1
let settingsQueue: Promise<void> = Promise.resolve()
let initStarted = false

export const useStore = create<State>((set, get) => ({
  ready: false,
  route: 'library',
  settings: null,
  systemInfo: null,
  accounts: [],
  instances: [],
  java: [],
  javaRuntimes: [],
  versions: [],
  latest: { release: '', snapshot: '' },
  providers: { modrinth: true, curseforge: { available: false, mode: 'none', bulk: false } },
  progress: {},
  busy: {},
  running: {},
  logs: {},
  consoleFor: null,
  detailInstance: null,
  detailTab: 'overview',
  editorFor: null,
  editorTab: 'mod',
  accountsOpen: false,
  shortcutsOpen: false,
  browseTarget: null,
  settingsAnchor: null,
  toasts: [],
  playStatus: null,

  async init() {
    if (initStarted) return // guard against React StrictMode's double effect run
    initStarted = true

    api.onProgress((e: ProgressEvent) => {
      set((s) => {
        const busy = { ...s.busy }
        const running = { ...s.running }
        if (e.phase === 'running') {
          running[e.instanceId] = true
          busy[e.instanceId] = false
        } else if (e.phase === 'done' || e.phase === 'error') {
          running[e.instanceId] = false
          busy[e.instanceId] = false
        } else {
          busy[e.instanceId] = true
        }
        return { progress: { ...s.progress, [e.instanceId]: e }, busy, running }
      })
      if (e.phase === 'error') {
        const fixed = e.action
          ? { title: e.label, action: { label: fixLabel(e.action), fix: e.action, instanceId: e.instanceId } }
          : { title: e.label, explain: true, instanceId: e.instanceId }
        get().toast(e.detail || e.label, 'error', e.detail ? fixed : { explain: true, instanceId: e.instanceId })
      }
      if (e.phase === 'done' || e.phase === 'error') get().refreshInstances()
    })

    api.onLog((line: LogLine) => {
      set((s) => {
        const prev = s.logs[line.instanceId] ?? []
        const next = prev.length > 2000 ? [...prev.slice(-1800), line] : [...prev, line]
        return { logs: { ...s.logs, [line.instanceId]: next } }
      })
    })

    const [settings, systemInfo, accounts, instances, providers] = await Promise.all([
      api.getSettings(),
      api.getSystemInfo(),
      api.listAccounts(),
      api.listInstances(),
      api.providerStatus()
    ])
    set({ settings, systemInfo, accounts, instances, providers, ready: true })

    get().refreshPlayStatus()
    // Signing in to the official launcher happens outside Openforge; look
    // again whenever the player comes back to this window.
    window.addEventListener('focus', () => get().refreshPlayStatus())
    get().refreshJava()
    // The version manifest is nice-to-have; a blocked network must not stop the
    // launcher from opening and showing what is already installed.
    api
      .listVersions()
      .then(({ latest, versions }) => set({ latest, versions }))
      .catch(() => undefined)
  },

  setRoute: (route) => set({ route, browseTarget: null }),
  toast: (message, kind = 'info', options = {}) => {
    // The same failure often arrives twice (progress event + rejected call).
    if (get().toasts.some((t) => t.message === message && t.kind === kind)) return
    const id = toastSeq++
    let action = options.action
    let title = options.title
    let body = message
    if (!action && options.explain && kind === 'error') {
      const hint = explainError(message)
      if (hint) {
        title = title ?? message
        body = hint.fix
        if (hint.action) action = { label: hint.actionLabel ?? fixLabel(hint.action), fix: hint.action, instanceId: options.instanceId }
      }
    }
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind, message: body, title, action }] }))
    // Errors with a fix stay long enough to act on.
    setTimeout(() => get().dismissToast(id), action ? 12000 : kind === 'error' ? 9000 : 5200)
  },
  runFix: (fix, instanceId) => {
    const s = get()
    switch (fix) {
      case 'java':
        set({ route: 'settings', detailInstance: null, browseTarget: null })
        break
      case 'network':
        set({ route: 'settings', detailInstance: null, browseTarget: null, settingsAnchor: 'advanced' })
        break
      case 'accounts':
        set({ accountsOpen: true })
        break
      case 'launcher':
        s.openOfficialLauncher()
        break
      case 'repair':
        if (instanceId) s.repair(instanceId)
        break
      case 'console':
        if (instanceId) set({ consoleFor: instanceId })
        break
      case 'memory':
      case 'jvm':
        if (instanceId) set({ editorFor: instanceId, editorTab: 'settings' })
        break
      case 'content':
        if (instanceId) set({ editorFor: instanceId, editorTab: 'mod' })
        break
    }
  },
  setAccountsOpen: (open) => set({ accountsOpen: open }),
  setShortcutsOpen: (open) => set({ shortcutsOpen: open }),
  setDetailTab: (tab) => set({ detailTab: tab }),
  clearSettingsAnchor: () => set({ settingsAnchor: null }),
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  async refreshInstances() {
    set({ instances: await api.listInstances() })
  },
  async refreshAccounts() {
    set({ accounts: await api.listAccounts() })
  },
  saveSettings(patch) {
    // Apply at once so the change is live (theme, style) before the disk write
    // returns, then adopt the main process's normalized copy. Saves run one at
    // a time so a slow write can never land after a newer one.
    set((s) => ({ settings: s.settings ? { ...s.settings, ...patch } : s.settings }))
    const run = async (): Promise<void> => {
      const settings = await api.saveSettings(patch)
      const providers = await api.providerStatus()
      set({ settings, providers })
    }
    const next = settingsQueue.then(run, run)
    settingsQueue = next.catch(() => undefined)
    return next
  },
  async refreshJava() {
    try {
      const [java, javaRuntimes] = await Promise.all([api.discoverJava(), api.javaRuntimes()])
      set({ java, javaRuntimes })
    } catch {
      /* Java discovery is best-effort */
    }
  },

  async addOfflineAccount(username) {
    set({ accounts: await api.addOfflineAccount(username) })
  },
  async setActiveAccount(id) {
    set({ accounts: await api.setActiveAccount(id) })
  },
  async removeAccount(id) {
    set({ accounts: await api.removeAccount(id) })
  },
  async refreshPlayStatus() {
    try {
      set({ playStatus: await api.playStatus() })
    } catch {
      /* keep the last answer */
    }
  },
  async openOfficialLauncher() {
    try {
      await api.openOfficialLauncher()
      get().toast('Opening the Minecraft Launcher…', 'info')
    } catch (e) {
      get().toast(cleanError(e), 'error')
    }
  },

  async createInstance(input) {
    const inst = await api.createInstance(input)
    await get().refreshInstances()
    get().install(inst.id)
  },
  async deleteInstance(id) {
    await api.deleteInstance(id)
    set((s) => ({ detailInstance: s.detailInstance === id ? null : s.detailInstance }))
    await get().refreshInstances()
  },
  async duplicateInstance(id) {
    try {
      await api.duplicateInstance(id)
      get().toast('Instance duplicated', 'success')
    } catch (e) {
      get().toast(cleanError(e), 'error')
    }
    await get().refreshInstances()
  },
  async launch(id, quickPlay) {
    try {
      const res = await api.launchInstance(id, quickPlay)
      // Failures reported through a progress event already have a toast.
      if (!res.ok && res.error && !res.handled) get().toast(res.error, 'error', { explain: true, instanceId: id })
    } catch (e) {
      get().toast(cleanError(e), 'error', { explain: true, instanceId: id })
    }
  },
  async install(id) {
    try {
      await api.installInstance(id)
      get().toast('Instance ready to play', 'success')
    } catch (e) {
      get().toast(cleanError(e), 'error', { explain: true, instanceId: id })
    }
    get().refreshInstances()
  },
  async repair(id) {
    try {
      await api.repairInstance(id)
      get().toast('Files verified and repaired', 'success')
    } catch (e) {
      get().toast(cleanError(e), 'error', { explain: true, instanceId: id })
    }
    get().refreshInstances()
  },
  async kill(id) {
    await api.killInstance(id)
  },
  async installPack(input) {
    get().toast(`Installing ${input.name}…`, 'info')
    try {
      await api.installPack(input)
      set({ route: 'library', detailInstance: null })
      get().toast(`${input.name} installed`, 'success')
    } catch (e) {
      get().toast(cleanError(e), 'error')
    }
    get().refreshInstances()
  },
  async importPack() {
    try {
      const inst = await api.importPack()
      if (inst) {
        set({ route: 'library' })
        get().toast(`${inst.name} imported`, 'success')
      }
    } catch (e) {
      get().toast(cleanError(e), 'error')
    }
    get().refreshInstances()
  },
  async updatePack(id) {
    try {
      await api.updatePack(id)
      get().toast('Modpack updated — your worlds were left untouched', 'success')
    } catch (e) {
      get().toast(cleanError(e), 'error')
    }
    get().refreshInstances()
  },

  openConsole: (id) => set({ consoleFor: id }),
  openEditor: (id, tab) => set((s) => ({ editorFor: id, editorTab: tab ?? (id === s.editorFor ? s.editorTab : 'mod') })),
  openDetail: (id, tab) => set((s) => ({ detailInstance: id, detailTab: tab ?? (id === s.detailInstance ? s.detailTab : 'overview') })),
  browseFor: (instanceId, kind) => set({ route: 'discover', detailInstance: null, browseTarget: { instanceId, kind } })
}))

function fixLabel(fix: FixAction): string {
  return FIX_LABEL[fix]
}

/** The account the game will launch with, if any. */
export function activeAccount(accounts: AccountSummary[]): AccountSummary | null {
  return accounts.find((account) => account.active) ?? null
}
