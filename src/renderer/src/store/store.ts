import { create } from 'zustand'
import type {
  Account,
  CfMod,
  Instance,
  JavaInfo,
  LogLine,
  ProgressEvent,
  Settings,
  VersionSummary
} from '@shared/types'
import type { CfInstallInput, CreateInstanceInput } from '@shared/ipc'
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
  account: Account | null
  instances: Instance[]
  java: JavaInfo[]
  versions: VersionSummary[]
  latest: { release: string; snapshot: string }
  cfStatus: { available: boolean; mode: 'proxy' | 'direct' | 'none' }

  progress: Record<string, ProgressEvent>
  busy: Record<string, boolean>
  running: Record<string, boolean>
  logs: Record<string, LogLine[]>

  consoleFor: string | null
  detailInstance: string | null
  toasts: Toast[]

  init(): Promise<void>
  setRoute(r: Route): void
  toast(message: string, kind?: Toast['kind']): void
  dismissToast(id: number): void

  refreshInstances(): Promise<void>
  saveSettings(patch: Partial<Settings>): Promise<void>
  saveAccount(name: string): Promise<void>
  refreshJava(): Promise<void>

  createInstance(input: CreateInstanceInput): Promise<void>
  deleteInstance(id: string): Promise<void>
  launch(id: string): Promise<void>
  install(id: string): Promise<void>
  kill(id: string): Promise<void>
  cfInstall(input: CfInstallInput): Promise<void>

  openConsole(id: string | null): void
  openDetail(id: string | null): void
}

let toastSeq = 1
let initStarted = false

export const useStore = create<State>((set, get) => ({
  ready: false,
  route: 'library',
  settings: null,
  account: null,
  instances: [],
  java: [],
  versions: [],
  latest: { release: '', snapshot: '' },
  cfStatus: { available: false, mode: 'none' },
  progress: {},
  busy: {},
  running: {},
  logs: {},
  consoleFor: null,
  detailInstance: null,
  toasts: [],

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
        } else if (e.phase === 'done') {
          running[e.instanceId] = false
          busy[e.instanceId] = false
        } else if (e.phase === 'error') {
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

    const [settings, account, instances, cfStatus] = await Promise.all([
      api.getSettings(),
      api.getAccount(),
      api.listInstances(),
      api.cfStatus()
    ])
    set({ settings, account, instances, cfStatus, ready: true })
    get().refreshJava()
    api
      .listVersions()
      .then(({ latest, versions }) => set({ latest, versions }))
      .catch(() => undefined)
  },

  setRoute: (route) => set({ route }),
  toast: (message, kind = 'info') => {
    const id = toastSeq++
    set((s) => ({ toasts: [...s.toasts, { id, kind, message }] }))
    setTimeout(() => get().dismissToast(id), 5200)
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  async refreshInstances() {
    set({ instances: await api.listInstances() })
  },
  async saveSettings(patch) {
    const settings = await api.saveSettings(patch)
    const cfStatus = await api.cfStatus()
    set({ settings, cfStatus })
  },
  async saveAccount(name) {
    set({ account: await api.saveAccount(name) })
  },
  async refreshJava() {
    try {
      set({ java: await api.discoverJava() })
    } catch {
      /* ignore */
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
  async launch(id) {
    const res = await api.launchInstance(id)
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
  async kill(id) {
    await api.killInstance(id)
  },
  async cfInstall(input) {
    get().toast(`Installing ${input.name}…`, 'info')
    try {
      const inst = await api.cfInstall(input)
      set({ route: 'library', detailInstance: null })
      get().toast(`${input.name} installed`, 'success')
      void inst
    } catch (e) {
      get().toast(cleanError(e), 'error')
    }
    get().refreshInstances()
  },

  openConsole: (id) => set({ consoleFor: id }),
  openDetail: (id) => set({ detailInstance: id })
}))

export type { CfMod }
