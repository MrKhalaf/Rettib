import type { ElectronApi } from '../../shared/types'

declare global {
  interface Window {
    electronAPI: ElectronApi
  }
}

export {}
