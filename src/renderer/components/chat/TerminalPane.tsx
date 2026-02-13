import { useEffect, useMemo, useRef } from 'react'
import { Terminal } from 'xterm'
import { FitAddon } from 'xterm-addon-fit'
import 'xterm/css/xterm.css'

interface Props {
  conversationUuid: string | null
  activeConversationUuid: string | null
  output: string
  isTerminalRunning: boolean
  terminalError: string | null
  onStart: () => void
  onStop: () => void
  onSendInput: (data: string) => void
  onResize: (cols: number, rows: number) => void
}

function isResizeObserverSupported(): boolean {
  return typeof window !== 'undefined' && typeof window.ResizeObserver !== 'undefined'
}

export function TerminalPane({
  conversationUuid,
  activeConversationUuid,
  output,
  isTerminalRunning,
  terminalError,
  onStart,
  onStop,
  onSendInput,
  onResize
}: Props) {
  const terminalContainerRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const outputLengthRef = useRef(0)
  const conversationUuidRef = useRef<string | null>(conversationUuid)
  const onSendInputRef = useRef(onSendInput)
  const onResizeRef = useRef(onResize)

  onSendInputRef.current = onSendInput
  onResizeRef.current = onResize

  const isActiveConversation = useMemo(() => {
    return Boolean(
      isTerminalRunning &&
        activeConversationUuid &&
        conversationUuid &&
        activeConversationUuid.trim() &&
        conversationUuid.trim() &&
        activeConversationUuid === conversationUuid
    )
  }, [activeConversationUuid, conversationUuid, isTerminalRunning])

  useEffect(() => {
    const container = terminalContainerRef.current
    if (!container) {
      return
    }

    const terminal = new Terminal({
      fontFamily: 'SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      fontSize: 12,
      convertEol: true,
      cursorBlink: true,
      theme: {
        background: '#0f1116',
        foreground: '#cfd7e6',
        cursor: '#d9c6a0',
        selectionBackground: '#283147'
      }
    })
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(container)
    fitAddon.fit()

    terminalRef.current = terminal
    fitAddonRef.current = fitAddon

    onResizeRef.current(terminal.cols, terminal.rows)

    const dataDisposable = terminal.onData((data) => {
      onSendInputRef.current(data)
    })

    let resizeObserver: ResizeObserver | null = null
    if (isResizeObserverSupported()) {
      resizeObserver = new ResizeObserver(() => {
        if (!fitAddonRef.current || !terminalRef.current) {
          return
        }

        fitAddonRef.current.fit()
        onResizeRef.current(terminalRef.current.cols, terminalRef.current.rows)
      })

      resizeObserver.observe(container)
    }

    return () => {
      dataDisposable.dispose()
      resizeObserver?.disconnect()
      terminal.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
      outputLengthRef.current = 0
    }
  }, [])

  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) {
      return
    }

    if (conversationUuidRef.current !== conversationUuid) {
      conversationUuidRef.current = conversationUuid
      terminal.reset()
      terminal.write(output)
      outputLengthRef.current = output.length
      return
    }

    if (output.length < outputLengthRef.current) {
      terminal.reset()
      terminal.write(output)
      outputLengthRef.current = output.length
      return
    }

    if (output.length === outputLengthRef.current) {
      return
    }

    const delta = output.slice(outputLengthRef.current)
    terminal.write(delta)
    outputLengthRef.current = output.length
  }, [output])

  return (
    <section className="terminal-pane">
      <header className="terminal-toolbar">
        <div className={`terminal-status ${isActiveConversation ? 'active' : 'idle'}`}>
          {isActiveConversation ? 'Live terminal connected' : 'Terminal not running for this topic'}
        </div>
        <div className="terminal-actions">
          {isActiveConversation ? (
            <button type="button" className="input-btn btn-stop" onClick={onStop}>
              Stop Terminal
            </button>
          ) : (
            <button type="button" className="input-btn btn-send" onClick={onStart}>
              Resume Terminal
            </button>
          )}
        </div>
      </header>

      <div className="terminal-surface" ref={terminalContainerRef} />

      {terminalError && <p className="detail-inline-error terminal-error">{terminalError}</p>}
    </section>
  )
}
