import { useEffect, useRef, type FC } from 'react'
import type { Message } from './model.js'
import { MessageItem } from './MessageItem.js'

interface MessageListProps {
  messages: Message[]
  /** seatId → displayName 映射（从 entities/seat 传入，entities 不互相 import）*/
  displayNames?: Record<string, string>
}

export const MessageList: FC<MessageListProps> = ({ messages, displayNames = {} }) => {
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length])

  return (
    <div className="flex flex-col overflow-y-auto">
      {messages.map((msg) => (
        <MessageItem key={msg.id} message={msg} displayName={displayNames[msg.sender]} />
      ))}
      <div ref={bottomRef} />
    </div>
  )
}
