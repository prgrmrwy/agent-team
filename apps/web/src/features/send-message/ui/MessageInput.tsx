import { useState, useRef, type FC, type KeyboardEvent } from 'react'
import { Button } from '../../../shared/ui/button.js'
import { Dropdown } from '../../../shared/ui/dropdown.js'
import { wsClient } from '../../../shared/api/index.js'
import type { Channel, Seat } from '@agent-team/protocol'

interface MessageInputProps {
  taskId: string
  channel?: Channel
  seats?: Seat[]
}

export const MessageInput: FC<MessageInputProps> = ({
  taskId,
  channel = 'main',
  seats = [],
}) => {
  const [content, setContent] = useState('')
  const [mentions, setMentions] = useState<string[]>([])
  const [showMention, setShowMention] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  function handleSend() {
    const trimmed = content.trim()
    if (!trimmed) return
    wsClient.send({
      type: 'human-message',
      taskId,
      channel,
      content: trimmed,
      mention: mentions,
      refs: [],
    })
    setContent('')
    setMentions([])
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      handleSend()
    }
    if (e.key === '@') {
      setShowMention(true)
    }
  }

  function addMention(seatId: string) {
    if (!mentions.includes(seatId)) {
      setMentions((prev) => [...prev, seatId])
      // Append @seat into content
      const seat = seats.find((s) => s.id === seatId)
      if (seat) {
        setContent((prev) => prev + `@${seat.role} `)
      }
    }
    setShowMention(false)
    textareaRef.current?.focus()
  }

  const seatMenuItems = seats
    .filter((s) => s.status !== 'vacant')
    .map((s) => ({
      label: `${s.role} (${s.factory})`,
      onSelect: () => addMention(s.id),
    }))

  return (
    <div className="flex flex-col gap-2 border-t bg-background p-3">
      {mentions.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {mentions.map((seatId) => {
            const seat = seats.find((s) => s.id === seatId)
            return (
              <span
                key={seatId}
                className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary"
              >
                @{seat?.role ?? seatId}
                <button
                  type="button"
                  onClick={() => setMentions((prev) => prev.filter((id) => id !== seatId))}
                  className="hover:text-destructive"
                >
                  ×
                </button>
              </span>
            )
          })}
        </div>
      )}
      <div className="flex gap-2">
        <textarea
          ref={textareaRef}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="输入消息... (Cmd+Enter 发送)"
          rows={2}
          className="flex-1 resize-none rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
        <div className="flex flex-col gap-1">
          {seatMenuItems.length > 0 && (
            <Dropdown
              trigger={
                <button
                  type="button"
                  className="rounded-md border px-2 py-1 text-xs hover:bg-accent"
                >
                  @提及
                </button>
              }
              items={seatMenuItems}
            />
          )}
          <Button size="sm" onClick={handleSend} disabled={!content.trim()}>
            发送
          </Button>
        </div>
      </div>
    </div>
  )
}
