import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type { AuthEvent, OpenforgeApi } from '../shared/ipc'
import type { LogLine, ProgressEvent } from '../shared/types'

/** Subscribe to a main-process broadcast, returning an unsubscribe function. */
function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_: unknown, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: OpenforgeApi = {
  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  saveSettings: (patch) => ipcRenderer.invoke(IPC.saveSettings, patch),
  getSystemInfo: () => ipcRenderer.invoke(IPC.getSystemInfo),
  networkCheck: () => ipcRenderer.invoke(IPC.networkCheck),

  listAccounts: () => ipcRenderer.invoke(IPC.listAccounts),
  addOfflineAccount: (username) => ipcRenderer.invoke(IPC.addOfflineAccount, username),
  setActiveAccount: (id) => ipcRenderer.invoke(IPC.setActiveAccount, id),
  removeAccount: (id) => ipcRenderer.invoke(IPC.removeAccount, id),
  startMicrosoftLogin: () => ipcRenderer.invoke(IPC.startMicrosoftLogin),
  cancelMicrosoftLogin: () => ipcRenderer.invoke(IPC.cancelMicrosoftLogin),

  discoverJava: () => ipcRenderer.invoke(IPC.discoverJava),
  javaRuntimes: () => ipcRenderer.invoke(IPC.javaRuntimes),
  installJavaRuntime: (major) => ipcRenderer.invoke(IPC.installJavaRuntime, major),
  removeJavaRuntime: (major) => ipcRenderer.invoke(IPC.removeJavaRuntime, major),

  listVersions: () => ipcRenderer.invoke(IPC.listVersions),
  loaderVersions: (loader, mcVersion) => ipcRenderer.invoke(IPC.loaderVersions, loader, mcVersion),

  listInstances: () => ipcRenderer.invoke(IPC.listInstances),
  createInstance: (input) => ipcRenderer.invoke(IPC.createInstance, input),
  deleteInstance: (id) => ipcRenderer.invoke(IPC.deleteInstance, id),
  duplicateInstance: (id) => ipcRenderer.invoke(IPC.duplicateInstance, id),
  updateInstance: (id, patch) => ipcRenderer.invoke(IPC.updateInstance, id, patch),
  installInstance: (id) => ipcRenderer.invoke(IPC.installInstance, id),
  repairInstance: (id) => ipcRenderer.invoke(IPC.repairInstance, id),
  launchInstance: (id, quickPlay) => ipcRenderer.invoke(IPC.launchInstance, id, quickPlay),
  killInstance: (id) => ipcRenderer.invoke(IPC.killInstance, id),
  openInstanceFolder: (id) => ipcRenderer.invoke(IPC.openInstanceFolder, id),
  listWorlds: (id) => ipcRenderer.invoke(IPC.listWorlds, id),
  backupWorld: (id, folderName) => ipcRenderer.invoke(IPC.backupWorld, id, folderName),

  installPack: (input) => ipcRenderer.invoke(IPC.installPack, input),
  importPack: () => ipcRenderer.invoke(IPC.importPack),
  exportPack: (id, format) => ipcRenderer.invoke(IPC.exportPack, id, format),
  checkPackUpdate: (id) => ipcRenderer.invoke(IPC.checkPackUpdate, id),
  updatePack: (id) => ipcRenderer.invoke(IPC.updatePack, id),

  listContent: (id, kind) => ipcRenderer.invoke(IPC.listContent, id, kind),
  importContent: (id, kind) => ipcRenderer.invoke(IPC.importContent, id, kind),
  toggleContent: (id, kind, fileName, enabled) =>
    ipcRenderer.invoke(IPC.toggleContent, id, kind, fileName, enabled),
  deleteContent: (id, kind, fileName) => ipcRenderer.invoke(IPC.deleteContent, id, kind, fileName),
  installContent: (id, input) => ipcRenderer.invoke(IPC.installContent, id, input),
  checkContentUpdates: (id, kind) => ipcRenderer.invoke(IPC.checkContentUpdates, id, kind),
  updateContent: (id, kind) => ipcRenderer.invoke(IPC.updateContent, id, kind),

  searchContent: (input) => ipcRenderer.invoke(IPC.searchContent, input),
  getProject: (provider, id) => ipcRenderer.invoke(IPC.getProject, provider, id),
  getVersions: (provider, id) => ipcRenderer.invoke(IPC.getVersions, provider, id),
  providerStatus: () => ipcRenderer.invoke(IPC.providerStatus),

  pickDirectory: () => ipcRenderer.invoke(IPC.pickDirectory),
  pickFile: (filters) => ipcRenderer.invoke(IPC.pickFile, filters),
  openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url),
  openFolder: (path) => ipcRenderer.invoke(IPC.openFolder, path),

  minimizeWindow: () => ipcRenderer.send(IPC.winMinimize),
  toggleMaximizeWindow: () => ipcRenderer.send(IPC.winMaximize),
  closeWindow: () => ipcRenderer.send(IPC.winClose),

  onProgress: (cb) => subscribe<ProgressEvent>(IPC.progressEvent, cb),
  onLog: (cb) => subscribe<LogLine>(IPC.logEvent, cb),
  onAuthEvent: (cb) => subscribe<AuthEvent>(IPC.authEvent, cb)
}

contextBridge.exposeInMainWorld('openforge', api)
