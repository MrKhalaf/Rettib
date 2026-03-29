import { useCallback, useEffect, useRef, useState } from 'react'

import type { ChatSessionCommandMode, TerminalEvent, TerminalSessionState } from '../../shared/types'
import { terminalApi } from '../api/terminal'

export function useTaskTerminal(taskId: number | null, workstreamId: number | null) {
  const [isRunning, setIsRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [output, setOutput] = useState('')
  const outputRef = useRef('')
  const taskIdRef = useRef(taskId)

  // Reset on task change
  useEffect(() => {
    if (taskIdRef.current !== taskId) {
      taskIdRef.current = taskId
      setOutput('')
      outputRef.current = ''
      setError(null)
      setIsRunning(false)

      // Attach if session exists
      if (taskId !== null) {
        terminalApi.attach(taskId).then((result) => {
          if (result && result.output) {
            outputRef.current = result.output
            setOutput(result.output)
            setIsRunning(true)
          }
        }).catch(() => {})

        // Also check active sessions
        terminalApi.sessions().then((sessions) => {
          const match = sessions.find((s) => s.task_id === taskId && s.is_active)
          if (match) setIsRunning(true)
        }).catch(() => {})
      }
    }
  }, [taskId])

  // Subscribe to terminal events
  useEffect(() => {
    const unsubscribe = terminalApi.onEvent((event: TerminalEvent) => {
      if (event.task_id !== taskIdRef.current) return

      if (event.type === 'started') {
        setIsRunning(true)
        setError(null)
      } else if (event.type === 'exit' || event.type === 'stopped') {
        setIsRunning(false)
      } else if (event.type === 'error') {
        setError(event.message ?? 'Unknown error')
      } else if (event.type === 'output' && event.output) {
        outputRef.current += event.output
        setOutput(outputRef.current)
      }
    })

    return unsubscribe
  }, [])

  const start = useCallback(
    async (commandMode: ChatSessionCommandMode = 'claude') => {
      if (taskId === null || workstreamId === null) return
      setError(null)

      try {
        await terminalApi.start({ task_id: taskId, workstream_id: workstreamId, command_mode: commandMode })
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to start terminal')
      }
    },
    [taskId, workstreamId]
  )

  const stop = useCallback(async () => {
    if (taskId === null) return

    try {
      await terminalApi.stop(taskId)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to stop terminal')
    }
  }, [taskId])

  const sendInput = useCallback(
    (data: string) => {
      if (taskId === null) return
      terminalApi.input(taskId, data).catch(() => {})
    },
    [taskId]
  )

  const resize = useCallback(
    (cols: number, rows: number) => {
      if (taskId === null) return
      terminalApi.resize(taskId, cols, rows).catch(() => {})
    },
    [taskId]
  )

  const saveScroll = useCallback(
    (offset: number) => {
      if (taskId === null) return
      terminalApi.saveScroll(taskId, offset).catch(() => {})
    },
    [taskId]
  )

  return { isRunning, error, output, start, stop, sendInput, resize, saveScroll }
}
