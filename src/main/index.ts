import { app, BrowserWindow, ipcMain, nativeImage, shell } from 'electron'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { IPC } from '@shared/ipc'
import { registerIpc } from './ipc'
import { migrateLegacyUserData, removeLegacyAuthCredential } from './core/migrate'

app.setName('Openforge')

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(__dirname, '../../build/icon.png')
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 960,
    minHeight: 640,
    show: false,
    frame: false,
    backgroundColor: '#191a1f',
    title: 'Openforge',
    icon: existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : undefined,
    webPreferences: {
      // electron-vite emits the preload as .mjs because package.json is type:module
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // Open target=_blank / external links in the system browser, never in-app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Window controls for the custom (frameless) title bar.
ipcMain.on(IPC.winMinimize, () => mainWindow?.minimize())
ipcMain.on(IPC.winMaximize, () => {
  if (!mainWindow) return
  if (mainWindow.isMaximized()) mainWindow.unmaximize()
  else mainWindow.maximize()
})
ipcMain.on(IPC.winClose, () => mainWindow?.close())

app.whenReady().then(() => {
  app.setAppUserModelId('com.noahroe.openforge')
  // Must run before registerIpc(), which immediately reads settings/instances.
  migrateLegacyUserData((msg) => console.log('[Openforge]', msg))
  removeLegacyAuthCredential((msg) => console.log('[Openforge]', msg))
  registerIpc(() => mainWindow)
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
