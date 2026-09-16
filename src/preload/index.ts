import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type { OpenforgeApi } from '../shared/ipc'
import type { LogLine, ProgressEvent } from '../shared/types'

const api: OpenforgeApi = {
  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  saveSettings: (patch) => ipcRenderer.invoke(IPC.saveSettings, patch),
  getSystemInfo: () => ipcRenderer.invoke(IPC.getSystemInfo),
  getAccount: () => ipcRenderer.invoke(IPC.getAccount),
  saveAccount: (username) => ipcRenderer.invoke(IPC.saveAccount, username),
  discoverJava: () => ipcRenderer.invoke(IPC.discoverJava),
  listVersions: () => ipcRenderer.invoke(IPC.listVersions),
  fabricVersions: (mcVersion) => ipcRenderer.invoke(IPC.fabricVersions, mcVersion),
  loaderVersions: (loader, mcVersion) => ipcRenderer.invoke(IPC.loaderVersions, loader, mcVersion),

  listInstances: () => ipcRenderer.invoke(IPC.listInstances),
  createInstance: (input) => ipcRenderer.invoke(IPC.createInstance, input),
  deleteInstance: (id) => ipcRenderer.invoke(IPC.deleteInstance, id),
  updateInstance: (id, patch) => ipcRenderer.invoke(IPC.updateInstance, id, patch),
  installInstance: (id) => ipcRenderer.invoke(IPC.installInstance, id),
  launchInstance: (id) => ipcRenderer.invoke(IPC.launchInstance, id),
  killInstance: (id) => ipcRenderer.invoke(IPC.killInstance, id),
  listMods: (id) => ipcRenderer.invoke(IPC.listMods, id),
  importMods: (id) => ipcRenderer.invoke(IPC.importMods, id),
  toggleMod: (id, fileName, enabled) => ipcRenderer.invoke(IPC.toggleMod, id, fileName, enabled),
  deleteMod: (id, fileName) => ipcRenderer.invoke(IPC.deleteMod, id, fileName),
  installCfMod: (id, projectId) => ipcRenderer.invoke(IPC.installCfMod, id, projectId),
  updateMods: (id) => ipcRenderer.invoke(IPC.updateMods, id),
  exportPack: (id) => ipcRenderer.invoke(IPC.exportPack, id),

  cfSearch: (input) => ipcRenderer.invoke(IPC.cfSearch, input),
  cfMod: (id) => ipcRenderer.invoke(IPC.cfMod, id),
  cfFiles: (id, page) => ipcRenderer.invoke(IPC.cfFiles, id, page),
  cfInstall: (input) => ipcRenderer.invoke(IPC.cfInstall, input),
  cfStatus: () => ipcRenderer.invoke(IPC.cfStatus),

  pickDirectory: () => ipcRenderer.invoke(IPC.pickDirectory),
  openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url),
  openFolder: (path) => ipcRenderer.invoke(IPC.openFolder, path),

  minimizeWindow: () => ipcRenderer.send(IPC.winMinimize),
  toggleMaximizeWindow: () => ipcRenderer.send(IPC.winMaximize),
  closeWindow: () => ipcRenderer.send(IPC.winClose),

  onProgress: (cb: (e: ProgressEvent) => void) => {
    const listener = (_: unknown, e: ProgressEvent): void => cb(e)
    ipcRenderer.on(IPC.progressEvent, listener)
    return () => ipcRenderer.removeListener(IPC.progressEvent, listener)
  },
  onLog: (cb: (e: LogLine) => void) => {
    const listener = (_: unknown, e: LogLine): void => cb(e)
    ipcRenderer.on(IPC.logEvent, listener)
    return () => ipcRenderer.removeListener(IPC.logEvent, listener)
  }
}

contextBridge.exposeInMainWorld('openforge', api)
