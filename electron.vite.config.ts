import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { encodeKeyBlob } from './src/main/core/keyblob'

// Release builds embed a CurseForge key from OPENFORGE_CF_KEY, lightly
// obfuscated with a fresh random pad per build. Without the variable (any build
// from source) the blob is empty and the app simply has no built-in key.
// Main process only: the renderer never sees the key, just the mode.
const cfKeyBlob = encodeKeyBlob((process.env['OPENFORGE_CF_KEY'] ?? '').trim())

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    define: {
      __OPENFORGE_CF_KEY_BLOB__: JSON.stringify(cfKeyBlob)
    },
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    },
    build: {
      rollupOptions: {
        input: { index: resolve('src/main/index.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    },
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    resolve: {
      alias: {
        '@': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: { index: resolve('src/renderer/index.html') }
      }
    }
  }
})
