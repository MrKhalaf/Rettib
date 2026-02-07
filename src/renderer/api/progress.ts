import { getElectronApi } from './electron-api'

export const progressApi = {
  log: (workstreamId: number, note: string) => getElectronApi().progress.log(workstreamId, note),
  list: (workstreamId: number) => getElectronApi().progress.list(workstreamId)
}
