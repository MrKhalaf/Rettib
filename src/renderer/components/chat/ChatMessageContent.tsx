import { Fragment } from 'react'

interface Props {
  text: string
}

type MarkdownBlock =
  | { type: 'paragraph'; text: string }
  | { type: 'heading'; level: 1 | 2 | 3; text: string }
  | { type: 'list'; items: string[] }
  | { type: 'code'; language: string; code: string }

function parseMarkdownBlocks(input: string): MarkdownBlock[] {
  const lines = input.replace(/\r/g, '').split('\n')
  const blocks: MarkdownBlock[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]

    if (!line.trim()) {
      index += 1
      continue
    }

    const fenceMatch = line.match(/^```\s*([A-Za-z0-9_+-]*)\s*$/)
    if (fenceMatch) {
      const language = fenceMatch[1] || 'text'
      index += 1
      const codeLines: string[] = []

      while (index < lines.length && !lines[index].match(/^```\s*$/)) {
        codeLines.push(lines[index])
        index += 1
      }

      if (index < lines.length) {
        index += 1
      }

      blocks.push({ type: 'code', language, code: codeLines.join('\n') })
      continue
    }

    const headingMatch = line.match(/^\s{0,3}(#{1,3})\s+(.+)$/)
    if (headingMatch) {
      blocks.push({
        type: 'heading',
        level: headingMatch[1].length as 1 | 2 | 3,
        text: headingMatch[2].trim()
      })
      index += 1
      continue
    }

    if (line.match(/^\s*[-*]\s+/)) {
      const items: string[] = []
      while (index < lines.length && lines[index].match(/^\s*[-*]\s+/)) {
        items.push(lines[index].replace(/^\s*[-*]\s+/, '').trim())
        index += 1
      }

      if (items.length > 0) {
        blocks.push({ type: 'list', items })
      }
      continue
    }

    const paragraphLines: string[] = []
    while (
      index < lines.length &&
      lines[index].trim().length > 0 &&
      !lines[index].match(/^```\s*([A-Za-z0-9_+-]*)\s*$/) &&
      !lines[index].match(/^\s*[-*]\s+/)
    ) {
      paragraphLines.push(lines[index].trim())
      index += 1
    }

    blocks.push({ type: 'paragraph', text: paragraphLines.join(' ') })
  }

  return blocks
}

function renderBoldText(text: string, keyPrefix: string) {
  const nodes: Array<{ type: 'text' | 'bold'; value: string }> = []
  const regex = /(\*\*|__)(.+?)\1/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push({ type: 'text', value: text.slice(lastIndex, match.index) })
    }

    nodes.push({ type: 'bold', value: match[2] })
    lastIndex = regex.lastIndex
  }

  if (lastIndex < text.length) {
    nodes.push({ type: 'text', value: text.slice(lastIndex) })
  }

  return nodes.map((node, index) =>
    node.type === 'bold' ? (
      <strong className="chat-md-strong" key={`${keyPrefix}-bold-${index}`}>
        {node.value}
      </strong>
    ) : (
      <Fragment key={`${keyPrefix}-text-${index}`}>{node.value}</Fragment>
    )
  )
}

function renderInlineMarkdown(text: string) {
  const nodes: Array<{ type: 'text' | 'code'; value: string }> = []
  const regex = /`([^`]+)`/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push({ type: 'text', value: text.slice(lastIndex, match.index) })
    }

    nodes.push({ type: 'code', value: match[1] })
    lastIndex = regex.lastIndex
  }

  if (lastIndex < text.length) {
    nodes.push({ type: 'text', value: text.slice(lastIndex) })
  }

  return nodes.flatMap((node, index) => {
    if (node.type === 'code') {
      return <code key={`code-${index}`}>{node.value}</code>
    }

    return renderBoldText(node.value, `text-${index}`)
  })
}

export function ChatMessageContent({ text }: Props) {
  const blocks = parseMarkdownBlocks(text)

  if (blocks.length === 0) {
    return <p />
  }

  return (
    <>
      {blocks.map((block, blockIndex) => {
        if (block.type === 'code') {
          return (
            <pre key={`code-block-${blockIndex}`} className="chat-code-block">
              <div className="code-header">
                <span>{block.language}</span>
              </div>
              <code>{block.code}</code>
            </pre>
          )
        }

        if (block.type === 'list') {
          return (
            <ul key={`list-${blockIndex}`}>
              {block.items.map((item, itemIndex) => (
                <li key={`item-${blockIndex}-${itemIndex}`}>{renderInlineMarkdown(item)}</li>
              ))}
            </ul>
          )
        }

        if (block.type === 'heading') {
          return (
            <p key={`heading-${blockIndex}`} className={`chat-md-heading chat-md-heading-${block.level}`}>
              {renderInlineMarkdown(block.text)}
            </p>
          )
        }

        return <p key={`paragraph-${blockIndex}`}>{renderInlineMarkdown(block.text)}</p>
      })}
    </>
  )
}
