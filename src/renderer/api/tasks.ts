import type { UpdateTaskInput } from '../../shared/types'
import { getElectronApi } from './electron-api'

export const tasksApi = {
  list: (workstreamId: number) => getElectronApi().tasks.list(workstreamId),
  create: (workstreamId: number, title: string) => getElectronApi().tasks.create(workstreamId, title),
  update: (id: number, data: UpdateTaskInput) => getElectronApi().tasks.update(id, data)
}
