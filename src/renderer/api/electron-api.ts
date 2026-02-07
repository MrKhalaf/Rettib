import type { ElectronApi } from '../../shared/types'

export function getElectronApi(): ElectronApi {
  const api = window.electronAPI
  if (!api) {
    throw new Error('Electron API bridge is unavailable. Open Rettib desktop window, not just the browser tab.')
  }

  return api
}
