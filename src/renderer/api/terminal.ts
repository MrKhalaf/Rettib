import type { StartTerminalSessionInput, TerminalEvent } from '../../shared/types'
import { getElectronApi } from './electron-api'

export const terminalApi = {
  start: (input: StartTerminalSessionInput) => getElectronApi().terminal.start(input),
  stop: (taskId: number) => getElectronApi().terminal.stop(taskId),
  attach: (taskId: number) => getElectronApi().terminal.attach(taskId),
  detach: (taskId: number, scrollOffset: number) => getElectronApi().terminal.detach(taskId, scrollOffset),
  input: (taskId: number, data: string) => getElectronApi().terminal.input(taskId, data),
  resize: (taskId: number, cols: number, rows: number) => getElectronApi().terminal.resize(taskId, cols, rows),
  sessions: () => getElectronApi().terminal.sessions(),
  saveScroll: (taskId: number, offset: number) => getElectronApi().terminal.saveScroll(taskId, offset),
  onEvent: (listener: (event: TerminalEvent) => void) => getElectronApi().terminal.onEvent(listener)
}
