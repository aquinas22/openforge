import type { OpenForgeApi } from '@shared/ipc'

declare global {
  interface Window {
    openforge: OpenForgeApi
  }
}

export {}
