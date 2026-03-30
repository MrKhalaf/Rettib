import { useCallback, useEffect, useRef, useState } from 'react'

import type { ChatSessionCommandMode, TerminalEvent, TerminalSessionState } from '../../shared/types'
import { terminalApi } from '../api/terminal'

const EMPTY_TERMINAL_SESSION: TerminalSessionState = {
  is_active: false,
  task_id: null,
  conversation_uuid: null,
  workstream_id: null,
  cwd: null,
  command_mode: null,
  started_at: null
}

export function useTaskTerminal(taskId: number | null, workstreamId: number | null) {
  const [isRunning, setIsRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [output, setOutput] = useState('')
  const [sessionState, setSessionState] = useState<TerminalSessionState>(EMPTY_TERMINAL_SESSION)

  const outputRef = useRef('')
  const taskIdRef = useRef(taskId)

  const attachToTask = useCallback(async (nextTaskId: number) => {
    const attachedSession = await terminalApi.attach(nextTaskId).catch(() => null)
    if (taskIdRef.current !== nextTaskId || !attachedSession) {
      return
    }

    if (!attachedSession.output) {
      return
    }

    outputRef.current += attachedSession.output
    setOutput(outputRef.current)
  }, [])

  useEffect(() => {
    let cancelled = false

    if (taskIdRef.current !== taskId) {
      taskIdRef.current = taskId
      outputRef.current = ''
      setOutput('')
      setError(null)
      setIsRunning(false)
      setSessionState(EMPTY_TERMINAL_SESSION)
    }

    if (taskId === null) {
      return () => {
        cancelled = true
      }
    }

    void Promise.all([
      terminalApi.attach(taskId).catch(() => null),
      terminalApi.sessions().catch(() => [])
    ]).then(([attachedSession, sessions]) => {
      if (cancelled || taskIdRef.current !== taskId) {
        return
      }

      if (attachedSession?.output) {
        outputRef.current = attachedSession.output
        setOutput(attachedSession.output)
      }

      const activeSession = sessions.find((session) => session.task_id === taskId && session.is_active) ?? null
      if (activeSession) {
        setSessionState(activeSession)
        setIsRunning(true)
        void attachToTask(taskId)
        return
      }

      if (attachedSession) {
        setIsRunning(true)
      }
    })

    return () => {
      cancelled = true
    }
  }, [attachToTask, taskId])

  useEffect(() => {
    const unsubscribe = terminalApi.onEvent((event: TerminalEvent) => {
      if (event.task_id !== taskIdRef.current) {
        return
      }

      if (event.type === 'started') {
        setIsRunning(true)
        setError(null)
        setSessionState(event.state ?? EMPTY_TERMINAL_SESSION)
        if (event.task_id !== null) {
          void attachToTask(event.task_id)
        }
        return
      }

      if (event.type === 'exit' || event.type === 'stopped') {
        setIsRunning(false)
        setSessionState(event.state ?? EMPTY_TERMINAL_SESSION)
        return
      }

      if (event.type === 'error') {
        setError(event.message ?? 'Unknown error')
        return
      }

      if (event.type === 'output' && event.output) {
        outputRef.current += event.output
        setOutput(outputRef.current)
      }
    })

    return unsubscribe
  }, [attachToTask])

  const start = useCallback(
    async (commandMode: ChatSessionCommandMode = 'claude') => {
      if (taskId === null || workstreamId === null) {
        return
      }

      setError(null)

      try {
        const state = await terminalApi.start({
          task_id: taskId,
          workstream_id: workstreamId,
          command_mode: commandMode
        })
        setSessionState(state)
        setIsRunning(state.is_active)
        await attachToTask(taskId)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to start terminal')
      }
    },
    [attachToTask, taskId, workstreamId]
  )

  const stop = useCallback(async () => {
    if (taskId === null) {
      return
    }

    try {
      await terminalApi.stop(taskId)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to stop terminal')
    }
  }, [taskId])

  const sendInput = useCallback(
    (data: string) => {
      if (taskId === null) {
        return
      }

      terminalApi.input(taskId, data).catch(() => {})
    },
    [taskId]
  )

  const resize = useCallback(
    (cols: number, rows: number) => {
      if (taskId === null) {
        return
      }

      terminalApi.resize(taskId, cols, rows).catch(() => {})
    },
    [taskId]
  )

  const saveScroll = useCallback(
    (offset: number) => {
      if (taskId === null) {
        return
      }

      terminalApi.saveScroll(taskId, offset).catch(() => {})
    },
    [taskId]
  )

  return { isRunning, error, output, sessionState, start, stop, sendInput, resize, saveScroll }
}
