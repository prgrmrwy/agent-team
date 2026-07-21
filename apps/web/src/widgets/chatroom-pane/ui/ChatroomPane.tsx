import { useEffect, useMemo, useRef, useState, type FC } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useVirtualizer } from '@tanstack/react-virtual'
import { MessageItem, CHANNEL_LABEL } from '../../../entities/chatroom/index.js'
import { MessageInput } from '../../../features/send-message/index.js'
import { wsClient, restClient } from '../../../shared/api/index.js'
import type { Channel, Message, Seat, ServerToClient } from '@agent-team/protocol'

const CHANNELS: Channel[] = ['main', 'eng-internal', 'tool-traces', 'mentions']

interface ChatroomPaneProps {
  taskId: string
  seats?: Seat[]
}

/** 从 seats 里构建 seatId → displayName 映射（需要 agents 数据；M1 先用 seat.role） */
function buildDisplayNames(seats: Seat[]): Record<string, string> {
  return Object.fromEntries(seats.map((s) => [s.id, s.role]))
}

export const ChatroomPane: FC<ChatroomPaneProps> = ({ taskId, seats = [] }) => {
  const queryClient = useQueryClient()
  const parentRef = useRef<HTMLDivElement>(null)
  const [activeChannel, setActiveChannel] = useState<Channel>('main')

  // 初次加载历史消息
  const { data: allMessages = [] } = useQuery<Message[]>({
    queryKey: ['messages', taskId],
    queryFn: () => restClient.get<Message[]>(`/tasks/${taskId}/messages`),
    staleTime: Number.POSITIVE_INFINITY, // WS 推送维护新鲜度
  })

  // 按频道过滤消息
  const messages = useMemo(
    () => allMessages.filter((m) => m.channel === activeChannel),
    [allMessages, activeChannel],
  )

  // 订阅 WS 事件，收到新消息追加到 query cache
  useEffect(() => {
    wsClient.subscribeTask(taskId)
    const remove = wsClient.addHandler((msg: ServerToClient) => {
      if (msg.type === 'chatroom-msg' && msg.taskId === taskId) {
        queryClient.setQueryData<Message[]>(['messages', taskId], (prev = []) => {
          // 去重
          if (prev.some((m) => m.id === msg.message.id)) return prev
          return [...prev, msg.message]
        })
      }
    })
    return () => {
      remove()
      wsClient.unsubscribeTask(taskId)
    }
  }, [taskId, queryClient])

  // Virtual list
  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 80,
    overscan: 5,
  })

  // 自动滚到底部
  useEffect(() => {
    if (messages.length > 0) {
      virtualizer.scrollToIndex(messages.length - 1, { behavior: 'smooth' })
    }
  }, [messages.length, virtualizer])

  const displayNames = buildDisplayNames(seats)

  return (
    <div className="flex h-full flex-col">
      {/* 频道 Tab 栏 */}
      <div className="flex border-b px-3">
        {CHANNELS.map((ch) => (
          <button
            key={ch}
            type="button"
            onClick={() => setActiveChannel(ch)}
            className={`px-3 py-1.5 text-xs font-medium transition-colors ${
              activeChannel === ch
                ? 'border-b-2 border-primary text-primary'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {CHANNEL_LABEL[ch]}
          </button>
        ))}
      </div>

      {/* 消息流 */}
      <div ref={parentRef} className="flex-1 overflow-y-auto px-3 py-2">
        <div
          style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }}
        >
          {virtualizer.getVirtualItems().map((vItem) => {
            const msg = messages[vItem.index]
            if (!msg) return null
            return (
              <div
                key={vItem.key}
                data-index={vItem.index}
                ref={virtualizer.measureElement}
                style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vItem.start}px)` }}
              >
                <MessageItem
                  message={msg}
                  displayName={displayNames[msg.sender]}
                />
              </div>
            )
          })}
        </div>
        {messages.length === 0 && (
          <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
            Chatroom 暂无消息
          </div>
        )}
      </div>

      {/* 输入框 */}
      <MessageInput taskId={taskId} channel={activeChannel} seats={seats} />
    </div>
  )
}
