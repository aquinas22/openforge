import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC } from '../shared/ipc'
import type { OpenforgeApi } from '../shared/ipc'
import type { LogLine, ProgressEvent, ServerLogLine, ServerStatus } from '../shared/types'

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

  playStatus: () => ipcRenderer.invoke(IPC.playStatus),
  openOfficialLauncher: () => ipcRenderer.invoke(IPC.openOfficialLauncher),

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
  openInstanceFolder: (id, sub) => ipcRenderer.invoke(IPC.openInstanceFolder, id, sub),
  listWorlds: (id) => ipcRenderer.invoke(IPC.listWorlds, id),
  backupWorld: (id, folderName) => ipcRenderer.invoke(IPC.backupWorld, id, folderName),

  listKeyBindings: (id) => ipcRenderer.invoke(IPC.listKeyBindings, id),
  resetKeyBindings: (id, ids) => ipcRenderer.invoke(IPC.resetKeyBindings, id, ids),
  openOptionsFile: (id) => ipcRenderer.invoke(IPC.openOptionsFile, id),
  listConfigFiles: (id) => ipcRenderer.invoke(IPC.listConfigFiles, id),
  openConfigFile: (id, relPath, reveal) => ipcRenderer.invoke(IPC.openConfigFile, id, relPath, reveal),
  planCleanup: (id) => ipcRenderer.invoke(IPC.planCleanup, id),
  runCleanup: (id, relPaths) => ipcRenderer.invoke(IPC.runCleanup, id, relPaths),

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
  addContentFiles: (id, kind, paths) => ipcRenderer.invoke(IPC.addContentFiles, id, kind, paths),
  planRetarget: (id, target) => ipcRenderer.invoke(IPC.planRetarget, id, target),
  retargetInstance: (id, input) => ipcRenderer.invoke(IPC.retargetInstance, id, input),
  pathForFile: (file) => webUtils.getPathForFile(file as Parameters<typeof webUtils.getPathForFile>[0]),

  searchContent: (input) => ipcRenderer.invoke(IPC.searchContent, input),
  getProject: (provider, id) => ipcRenderer.invoke(IPC.getProject, provider, id),
  getVersions: (provider, id) => ipcRenderer.invoke(IPC.getVersions, provider, id),
  providerStatus: () => ipcRenderer.invoke(IPC.providerStatus),

  listServers: () => ipcRenderer.invoke(IPC.listServers),
  saveServer: (input) => ipcRenderer.invoke(IPC.saveServer, input),
  deleteServer: (id) => ipcRenderer.invoke(IPC.deleteServer, id),
  serverStatuses: () => ipcRenderer.invoke(IPC.serverStatuses),
  serverLog: (id) => ipcRenderer.invoke(IPC.serverLog, id),
  startServer: (id) => ipcRenderer.invoke(IPC.startServer, id),
  stopServer: (id) => ipcRenderer.invoke(IPC.stopServer, id),
  killServer: (id) => ipcRenderer.invoke(IPC.killServer, id),
  sendServerCommand: (id, command) => ipcRenderer.invoke(IPC.sendServerCommand, id, command),
  refreshServer: (id) => ipcRenderer.invoke(IPC.refreshServer, id),
  tailServerLog: (id, on) => ipcRenderer.invoke(IPC.tailServerLog, id, on),
  testSshConnection: (input) => ipcRenderer.invoke(IPC.testSshConnection, input),
  inspectServerFolder: (dir) => ipcRenderer.invoke(IPC.inspectServerFolder, dir),
  acceptServerEula: (id) => ipcRenderer.invoke(IPC.setServerEula, id),
  createLocalServer: (input) => ipcRenderer.invoke(IPC.createLocalServer, input),

  pickDirectory: () => ipcRenderer.invoke(IPC.pickDirectory),
  pickFile: (filters) => ipcRenderer.invoke(IPC.pickFile, filters),
  openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url),
  openFolder: (path) => ipcRenderer.invoke(IPC.openFolder, path),

  minimizeWindow: () => ipcRenderer.send(IPC.winMinimize),
  toggleMaximizeWindow: () => ipcRenderer.send(IPC.winMaximize),
  closeWindow: () => ipcRenderer.send(IPC.winClose),

  onProgress: (cb) => subscribe<ProgressEvent>(IPC.progressEvent, cb),
  onLog: (cb) => subscribe<LogLine>(IPC.logEvent, cb),
  onServerLog: (cb) => subscribe<ServerLogLine>(IPC.serverLogEvent, cb),
  onServerStatus: (cb) => subscribe<ServerStatus>(IPC.serverStatusEvent, cb)
}

contextBridge.exposeInMainWorld('openforge', api)
