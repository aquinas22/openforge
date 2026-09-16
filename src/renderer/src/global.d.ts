import type { OpenforgeApi } from '@shared/ipc'

declare global {
  interface Window {
    openforge: OpenforgeApi
  }
}

export {}
