import { getElectronApi } from './electron-api'

export const appApi = {
  openObsidianNote: (noteRef: string) => getElectronApi().app.openObsidianNote(noteRef)
}
