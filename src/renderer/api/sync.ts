import { getElectronApi } from './electron-api'

export const syncApi = {
  run: (sourceId: number) => getElectronApi().sync.run(sourceId),
  runs: (sourceId: number) => getElectronApi().sync.runs(sourceId),
  getOrCreateSource: () => getElectronApi().sync.getOrCreateSource(),
  updateSourcePath: (sourcePath: string) => getElectronApi().sync.updateSourcePath(sourcePath),
  diagnostics: () => getElectronApi().sync.diagnostics()
}
