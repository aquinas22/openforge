import type { ArsFodinaApi } from '@shared/ipc'

declare global {
  interface Window {
    arsFodina: ArsFodinaApi
  }
}

export {}
