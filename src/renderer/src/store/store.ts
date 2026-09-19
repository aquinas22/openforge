import { create } from 'zustand'
import type {
  AccountSummary,
  DeviceCodePrompt,
  Instance,
  JavaInfo,
  JavaRuntimeStatus,
  LogLine,
  ProgressEvent,
  Settings,
  SystemInfo,
  VersionSummary
} from '@shared/types'
import type { AuthEvent, CreateInstanceInput, PackInstallInput, ProviderStatus, QuickPlayInput } from '@shared/ipc'
import { api } from '../api'
import { cleanError } from '../util'

export type Route = 'library' | 'discover' | 'settings'

export interface Toast {
  id: number
  kind: 'info' | 'success' | 'error'
  message: string
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
  toasts: Toast[]

  /** Live Microsoft sign-in, while the user finishes it in a browser. */
  authPrompt: DeviceCodePrompt | null
  authBusy: boolean

  init(): Promise<void>
  setRoute(r: Route): void
  toast(message: string, kind?: Toast['kind']): void
  dismissToast(id: number): void

  refreshInstances(): Promise<void>
  refreshAccounts(): Promise<void>
  saveSettings(patch: Partial<Settings>): Promise<void>
  refreshJava(): Promise<void>

  addOfflineAccount(username: string): Promise<void>
  setActiveAccount(id: string): Promise<void>
  removeAccount(id: string): Promise<void>
  startMicrosoftLogin(): Promise<void>
  cancelMicrosoftLogin(): Promise<void>

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
  openDetail(id: string | null): void
}

let toastSeq = 1
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
  toasts: [],
  authPrompt: null,
  authBusy: false,

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
      if (e.phase === 'error') get().toast(e.detail || e.label, 'error')
      if (e.phase === 'done' || e.phase === 'error') get().refreshInstances()
    })

    api.onLog((line: LogLine) => {
      set((s) => {
        const prev = s.logs[line.instanceId] ?? []
        const next = prev.length > 2000 ? [...prev.slice(-1800), line] : [...prev, line]
        return { logs: { ...s.logs, [line.instanceId]: next } }
      })
    })

    api.onAuthEvent((event: AuthEvent) => {
      if (event.kind === 'success') {
        set({ authPrompt: null, authBusy: false })
        get().toast(`Signed in as ${event.username}`, 'success')
        get().refreshAccounts()
      } else if (event.kind === 'error') {
        set({ authPrompt: null, authBusy: false })
        get().toast(event.message, 'error')
        get().refreshAccounts()
      } else if (event.kind === 'cancelled') {
        set({ authPrompt: null, authBusy: false })
      }
    })

    const [settings, systemInfo, accounts, instances, providers] = await Promise.all([
      api.getSettings(),
      api.getSystemInfo(),
      api.listAccounts(),
      api.listInstances(),
      api.providerStatus()
    ])
    set({ settings, systemInfo, accounts, instances, providers, ready: true })

    get().refreshJava()
    // The version manifest is nice-to-have; a blocked network must not stop the
    // launcher from opening and showing what is already installed.
    api
      .listVersions()
      .then(({ latest, versions }) => set({ latest, versions }))
      .catch(() => undefined)
  },

  setRoute: (route) => set({ route }),
  toast: (message, kind = 'info') => {
    const id = toastSeq++
    set((s) => ({ toasts: [...s.toasts, { id, kind, message }] }))
    setTimeout(() => get().dismissToast(id), 6200)
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  async refreshInstances() {
    set({ instances: await api.listInstances() })
  },
  async refreshAccounts() {
    set({ accounts: await api.listAccounts() })
  },
  async saveSettings(patch) {
    const settings = await api.saveSettings(patch)
    const providers = await api.providerStatus()
    set({ settings, providers })
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
  async startMicrosoftLogin() {
    set({ authBusy: true })
    try {
      const prompt = await api.startMicrosoftLogin()
      set({ authPrompt: prompt })
    } catch (e) {
      set({ authBusy: false })
      get().toast(cleanError(e), 'error')
    }
  },
  async cancelMicrosoftLogin() {
    await api.cancelMicrosoftLogin()
    set({ authPrompt: null, authBusy: false })
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
    const res = await api.launchInstance(id, quickPlay)
    if (!res.ok && res.error) get().toast(res.error, 'error')
    else get().toast('Launching Minecraft…', 'success')
  },
  async install(id) {
    try {
      await api.installInstance(id)
      get().toast('Instance ready to play', 'success')
    } catch (e) {
      get().toast(cleanError(e), 'error')
    }
    get().refreshInstances()
  },
  async repair(id) {
    try {
      await api.repairInstance(id)
      get().toast('Files verified and repaired', 'success')
    } catch (e) {
      get().toast(cleanError(e), 'error')
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
  openDetail: (id) => set({ detailInstance: id })
}))

/** The account the game will launch with, if any. */
export function activeAccount(accounts: AccountSummary[]): AccountSummary | null {
  return accounts.find((account) => account.active) ?? null
}
