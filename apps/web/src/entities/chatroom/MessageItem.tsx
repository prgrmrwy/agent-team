import type { FC } from 'react'
import ReactMarkdown from 'react-markdown'
import { formatTime } from '../../shared/lib/time.js'
import type { Message } from './model.js'

interface MessageItemProps {
  message: Message
  displayName?: string
}

export const MessageItem: FC<MessageItemProps> = ({ message, displayName }) => {
  const isHuman = message.sender === 'human'
  const isSystem = message.type === 'system-event'
  const name = displayName ?? message.sender

  if (isSystem) {
    return (
      <div className="flex justify-center py-2">
        <span className="rounded-full bg-muted px-3 py-0.5 text-xs text-muted-foreground">
          {message.content}
        </span>
      </div>
    )
  }

  return (
    <div className={['flex gap-3 py-2', isHuman ? 'flex-row-reverse' : ''].join(' ')}>
      <div
        className={[
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold',
          isHuman ? 'bg-primary text-primary-foreground' : 'bg-secondary text-secondary-foreground',
        ].join(' ')}
      >
        {name.slice(0, 1).toUpperCase()}
      </div>
      <div className={['max-w-[70%]', isHuman ? 'items-end' : 'items-start'].join(' ')}>
        <div className="mb-1 flex items-baseline gap-2">
          <span className="text-xs font-medium">{name}</span>
          <span className="text-xs text-muted-foreground">{formatTime(message.createdAt)}</span>
        </div>
        <div
          className={[
            'rounded-lg px-3 py-2 text-sm',
            isHuman ? 'bg-primary text-primary-foreground' : 'bg-secondary text-secondary-foreground',
          ].join(' ')}
        >
          <div className="prose prose-sm max-w-none dark:prose-invert">
            <ReactMarkdown>{message.content}</ReactMarkdown>
          </div>
        </div>
      </div>
    </div>
  )
}
