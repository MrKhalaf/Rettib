import type { CreateTaskInput, UpdateTaskInput } from '../../shared/types'
import { getElectronApi } from './electron-api'

export const tasksApi = {
  list: (workstreamId: number) => getElectronApi().tasks.list(workstreamId),
  create: (data: CreateTaskInput) => getElectronApi().tasks.create(data),
  update: (id: number, data: UpdateTaskInput) => getElectronApi().tasks.update(id, data),
  delete: (id: number) => getElectronApi().tasks.delete(id)
}
