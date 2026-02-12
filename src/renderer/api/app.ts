import { getElectronApi } from './electron-api'

export const appApi = {
  openObsidianNote: (noteRef: string) => getElectronApi().app.openObsidianNote(noteRef),
  pickContextFile: (options?: { defaultPath?: string | null }) => getElectronApi().app.pickContextFile(options)
}
