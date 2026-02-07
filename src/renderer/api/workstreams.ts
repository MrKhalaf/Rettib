import type { CreateWorkstreamInput, UpdateWorkstreamInput } from '../../shared/types'
import { getElectronApi } from './electron-api'

export const workstreamsApi = {
  list: () => getElectronApi().workstreams.list(),
  get: (id: number) => getElectronApi().workstreams.get(id),
  create: (data: CreateWorkstreamInput) => getElectronApi().workstreams.create(data),
  update: (id: number, data: UpdateWorkstreamInput) => getElectronApi().workstreams.update(id, data)
}
