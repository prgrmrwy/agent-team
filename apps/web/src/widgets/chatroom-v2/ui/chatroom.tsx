import { useEffect, useMemo, useRef, useState, type FC, type KeyboardEvent, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { QueryClient } from '@tanstack/react-query'
import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import { Avatar, type AvatarStatus } from '../../../shared/ui/avatar/index.js'
import {
  AgentAvatar,
  STATUS_LABEL,
  STATUS_COLOR,
  STATUS_GLOW,
  computeAvatarStatus,
  factoryToRoleName,
  pickDominantStatus,
} from '../../../shared/ui/agent-avatar/index.js'
import type { RoleName } from '../../../shared/icons/index.js'
import { restClient, wsClient } from '../../../shared/api/index.js'
import { useRightPanel } from '../../../shared/ui/right-panel.js'
import { formatTokenCount } from '../../../shared/lib/token-usage.js'
import { attachSeatAgents, normalizeSeats } from '../../../entities/seat/index.js'
import { openFileViewer, isInlineFilePath, isLocalFileHref } from '../../../features/file-viewer/index.js'
import { isUrgentSystemEvent, urgentKeyForContent } from '@agent-team/protocol'
import { markUrgentAcknowledged, mergeMessagesById } from './message-cache.js'
import type {
  Channel,
  Message,
  Seat,
  Agent,
  ServerToClient,
  AgentUsageResponse,
} from '@agent-team/protocol'

const CHANNELS: { value: Channel; label: string }[] = [
  { value: 'main', label: 'main' },
  { value: 'eng-internal', label: 'eng-internal' },
  { value: 'tool-traces', label: 'tool-traces' },
  { value: 'mentions', label: 'mentions' },
]
const RECENT_MESSAGE_SYNC_LIMIT = 200

// 6 角色固定顺序(design-handoff §5.10:planner → engineer → qa → pm-ux → anti → ci)
const SEAT_ORDER: RoleName[] = ['planner', 'engineer', 'qa', 'pmux', 'anti', 'ci']

interface ChatroomProps {
  taskId: string
}

async function syncRecentMessages(taskId: string, queryClient: QueryClient): Promise<void> {
  const cached = queryClient.getQueryData<Message[]>(['messages', taskId]) ?? []
  if (cached.length === 0) return

  const recent = await restClient.get<Message[]>(
    `/tasks/${taskId}/messages?limit=${RECENT_MESSAGE_SYNC_LIMIT}`,
  )
  if (recent.length === 0) return

  queryClient.setQueryData<Message[]>(['messages', taskId], (prev = []) => {
    return mergeMessagesById(prev, recent)
  })
}

/**
 * Chatroom widget — design-handoff §4-§5 综合实现
 *
 * 结构:
 *   [ channel tabs ]                 ← §5.7
 *   [ message list (virtualizer 略,直接 render;消息量大再加) ]   ← §5.5
 *   [ seats bar ]                    ← §5.10
 *   [ composer ]                     ← §5.8
 *
 * state-pipeline 在 task-page 头部独立放,不在本 widget。
 */
export const Chatroom: FC<ChatroomProps> = ({ taskId }) => {
  const queryClient = useQueryClient()
  const { closeRightPanel, openRightPanel } = useRightPanel()
  const [activeChannel, setActiveChannel] = useState<Channel>('main')
  const scrollRef = useRef<HTMLDivElement>(null)
  // 流式 partial:agentId → 当前 turn 累积 stream text。done 时正式 chatroom-msg 落表 → 清掉
  const [partialByAgent, setPartialByAgent] = useState<Record<string, { channel: Channel; content: string }>>({})
  // 开口时间排序(用户诉求):消息按 turn"开口时刻"排,而非定稿(createdAt)时刻。
  //   streamStartRef: agentId → 当前 turn 首帧 delta 到达时间(= 开口)
  //   msgStartRef:    msgId   → 所属 turn 的开口时间(排序键,优先于 createdAt)
  //   streamCleanupRef: turn 收尾后延迟清 streamStart 的 timer(让同 turn 多条共享开口时间)
  const streamStartRef = useRef<Map<string, number>>(new Map())
  const msgStartRef = useRef<Map<string, number>>(new Map())
  const streamCleanupRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  // 数据
  const { data: allMessages = [] } = useQuery<Message[]>({
    queryKey: ['messages', taskId],
    queryFn: () => restClient.get<Message[]>(`/tasks/${taskId}/messages`),
    staleTime: Number.POSITIVE_INFINITY,
  })
  const { data: rawSeats = [] } = useQuery<Seat[]>({
    queryKey: ['seats', taskId],
    queryFn: async () => normalizeSeats(await restClient.get<Seat[]>(`/tasks/${taskId}/seats`)),
  })
  const { data: rawAgents = [] } = useQuery<Agent[]>({
    queryKey: ['agents', taskId],
    queryFn: () => restClient.get<Agent[]>(`/tasks/${taskId}/agents`),
  })

  // derive-presence D3:task-process 在线状态。订阅时 server 回当前值,进程起/死推变化。
  // 默认 true(乐观,避免首屏闪"离线");收到 alive=false 才翻。
  const [processAlive, setProcessAlive] = useState(true)

  // 离线时:presence 一律显示 offline(绝不沿用陈旧 working/idle —— 消灭僵尸"假活")。
  // 只改 status/state(presence),保留 id/factory/role/currentAgentId/displayName,
  // 不影响 mention 路由 / profile 等非 presence 逻辑。
  const seats = useMemo<Seat[]>(
    () => {
      const withAgents = attachSeatAgents(rawSeats, rawAgents)
      return processAlive ? withAgents : withAgents.map((s) => ({ ...s, status: 'offline' as const }))
    },
    [processAlive, rawSeats, rawAgents],
  )
  const agents = useMemo<Agent[]>(
    () => rawAgents,
    [rawAgents],
  )

  // 排序键:优先 turn 开口时间(msgStartRef),否则回退 createdAt。
  // 这样 agent 边 stream 边被人类插话时,agent(先开口)整段稳定排在人类消息上方,
  // 不会因"定稿晚"而跳到人类下面。partial 草稿也用同一键插入(见下方 feed 合并)。
  const sortKeyOf = (m: Message) =>
    msgStartRef.current.get(m.id) ?? new Date(m.createdAt).getTime()
  const messages = useMemo(
    () =>
      allMessages
        .filter((m) => m.channel === activeChannel)
        .slice()
        .sort((a, b) => sortKeyOf(a) - sortKeyOf(b)),
    // partialByAgent 进 deps:msgStartRef 在 WS 回调里随 stream 收尾更新,
    // 用它触发重排(allMessages 变化也会触发)。
    [allMessages, activeChannel, partialByAgent],
  )

  // WS 实时更新
  useEffect(() => {
    const removeMsg = wsClient.addHandler((msg: ServerToClient) => {
      if (msg.type === 'chatroom-msg' && msg.taskId === taskId) {
        queryClient.setQueryData<Message[]>(['messages', taskId], (prev = []) => {
          if (prev.some((m) => m.id === msg.message.id)) return prev
          // dedup vs 乐观本地 message:同 sender + 内容 + 5s 内 createdAt
          const incoming = msg.message
          if (incoming.sender === 'human') {
            const incomingTime = new Date(incoming.createdAt).getTime()
            const localIdx = prev.findIndex(
              (m) =>
                m.id.startsWith('local-') &&
                m.sender === 'human' &&
                m.content === incoming.content &&
                Math.abs(new Date(m.createdAt).getTime() - incomingTime) < 5000,
            )
            if (localIdx >= 0) {
              // 用 server 真 id 替换本地 temp
              return prev.map((m, i) => (i === localIdx ? incoming : m))
            }
          }
          return [...prev, incoming]
        })
        // 真消息到了 → 清该 agent 的 partial 草稿 + 给消息打"开口时间"排序键
        if (msg.message.type === 'agent-text' || msg.message.type === 'agent-thinking') {
          const sender = msg.message.sender
          // 该消息属于一个 stream 过的 turn → 用开口时间排序(thinking+text 共享同一开口时间)
          const ts = streamStartRef.current.get(sender)
          if (ts != null) msgStartRef.current.set(msg.message.id, ts)
          setPartialByAgent((prev) => {
            if (!(sender in prev)) return prev
            const next = { ...prev }
            delete next[sender]
            return next
          })
          // turn 收尾:延迟清 streamStart,让同 turn 后续消息(thinking/text)拿到同一开口时间,
          // 但更晚的独立 turn / instant 消息回退用 createdAt。下一帧 delta 会取消此 timer。
          if (ts != null) {
            const old = streamCleanupRef.current.get(sender)
            if (old) clearTimeout(old)
            streamCleanupRef.current.set(
              sender,
              setTimeout(() => {
                streamStartRef.current.delete(sender)
                streamCleanupRef.current.delete(sender)
              }, 2500),
            )
          }
        }
      }
      // 流式 delta:仅 UI 用,不进 queryClient
      if (msg.type === 'chatroom-msg-delta' && msg.taskId === taskId) {
        // 新 turn 首帧 delta = 开口时刻(此 agent 当前无 streamStart 时记录)
        if (!streamStartRef.current.has(msg.agentId)) {
          streamStartRef.current.set(msg.agentId, Date.now())
        }
        // 仍在 stream → 取消上一次收尾的延迟清理
        const t = streamCleanupRef.current.get(msg.agentId)
        if (t) {
          clearTimeout(t)
          streamCleanupRef.current.delete(msg.agentId)
        }
        setPartialByAgent((prev) => ({
          ...prev,
          [msg.agentId]: { channel: msg.channel as Channel, content: msg.content },
        }))
      }
      if (msg.type === 'seat-state' && msg.taskId === taskId) {
        // derive-presence:seat-state 现在携带 presence(活进程派生)。映射回 SeatStatus
        // 喂现有 seat 缓存(spawning→init),computeAvatarStatus 不变。presence 是真相来源,
        // GET /seats 的 status 仅作首屏占位,会被 WS 快照/增量覆盖。
        const status = msg.presence === 'spawning' ? 'init' : msg.presence
        queryClient.setQueryData<Seat[]>(['seats', taskId], (prev = []) =>
          prev.map((s) =>
            s.id === msg.seatId
              ? {
                  ...s,
                  status,
                  currentAgentId:
                    msg.presence === 'vacant' || msg.presence === 'offline'
                      ? null
                      : (msg.agentId ?? s.currentAgentId ?? null),
                }
              : s,
          ),
        )
        if (msg.agentId && msg.displayName) {
          queryClient.setQueryData<Agent[]>(['agents', taskId], (prev = []) =>
            prev.some((a) => a.id === msg.agentId)
              ? prev.map((a) => (a.id === msg.agentId ? { ...a, displayName: msg.displayName ?? a.displayName } : a))
              : prev,
          )
        }
      }
      // derive-presence D3:进程在线状态变化 → 离线时全 seat 显示 offline
      if (msg.type === 'task-process-state' && msg.taskId === taskId) {
        setProcessAlive(msg.alive)
        // 进程回来时重拉一次 seats/agents,拿回真实 presence(替代乐观的旧值)
        if (msg.alive) {
          queryClient.invalidateQueries({ queryKey: ['seats', taskId] })
          queryClient.invalidateQueries({ queryKey: ['agents', taskId] })
        }
      }
    })
    wsClient.subscribeTask(taskId)
    void syncRecentMessages(taskId, queryClient).catch(() => {
      queryClient.invalidateQueries({ queryKey: ['messages', taskId] })
    })
    return () => {
      removeMsg()
      wsClient.unsubscribeTask(taskId)
    }
  }, [taskId, queryClient])

  // 急停:在本任务页面 600ms 内连按两次 Esc → 停止所有 agent 工作(打断在跑的 turn)。
  // 后端置 humanPaused + interrupt 所有 session,发条 system-event 确认;人类再发消息即恢复。
  const lastEscRef = useRef(0)
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const now = Date.now()
      if (now - lastEscRef.current < 800) {
        lastEscRef.current = 0
        wsClient.send({ type: 'control', taskId, action: 'pause' })
      } else {
        lastEscRef.current = now
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [queryClient, taskId])

  // sticky-bottom 自动滚:
  //  - 贴底时(或从未主动滚过)新消息/流式更新自动滚到底
  //  - 用户主动上滑 → 停滚;再滚回底部 → 恢复自动滚
  // ref 而非 state,避免每次 onScroll re-render。
  const stickRef = useRef(true)
  const handleScroll = () => {
    const el = scrollRef.current
    if (!el) return
    // 距底 < 48px 视为"在底部"(留点容差防抖动)
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
  }
  useEffect(() => {
    const el = scrollRef.current
    if (el && stickRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [messages.length, partialByAgent])

  // urgent system-event ack 现在直接存在 message 上，避免 indexDb 旁路状态与历史消息漂移。
  const ackedUrgents = useMemo(() => {
    const keys = new Set<string>()
    for (const message of allMessages) {
      if (!message.acknowledgedAt) continue
      keys.add(message.id)
      if (message.urgentKey) keys.add(message.urgentKey)
      if (isUrgentSystemEvent(message.content)) keys.add(urgentKeyForContent(message.content))
    }
    return keys
  }, [allMessages])
  const ackUrgent = (message: Message) => {
    const key = message.urgentKey ?? urgentKeyForContent(message.content)
    if (ackedUrgents.has(key) || ackedUrgents.has(message.id)) return
    // 乐观:本地立即合入,后台 POST;失败 invalidate 让用户看到回滚
    const acknowledgedAt = new Date().toISOString()
    queryClient.setQueryData<Message[]>(['messages', taskId], (prev = []) =>
      markUrgentAcknowledged(prev, [message.id, key], acknowledgedAt),
    )
    restClient
      .post<{ ok: true; acknowledgedAt: string; ids: string[] }>(
        `/tasks/${taskId}/messages/${encodeURIComponent(key)}/ack`,
        {},
      )
      .then((res) => {
        queryClient.setQueryData<Message[]>(['messages', taskId], (prev = []) =>
          markUrgentAcknowledged(prev, res.ids.length > 0 ? res.ids : [message.id, key], res.acknowledgedAt),
        )
        void queryClient.invalidateQueries({ queryKey: ['messages', taskId] })
      })
      .catch(() => {
        queryClient.invalidateQueries({ queryKey: ['messages', taskId] })
      })
  }

  // 浏览器通知:监听 allMessages 新增的 urgent system-event,发 Notification。
  // 仅在 tab 不可见(document.hidden)时发,避免盯着页面也响铃骚扰。
  // 用 ref 去重已通知的 message.id。
  const notifiedRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (typeof Notification === 'undefined') return
    if (Notification.permission === 'default') {
      // 首次出现 urgent 时请求权限;之后用户授权或拒绝就生效
      const hasUrgent = allMessages.some(
        (m) => m.type === 'system-event' && isUrgentSystemEvent(m.content),
      )
      if (hasUrgent) Notification.requestPermission().catch(() => {})
    }
    if (Notification.permission !== 'granted') return
    for (const m of allMessages) {
      if (m.type !== 'system-event' || !isUrgentSystemEvent(m.content)) continue
      if (notifiedRef.current.has(m.id)) continue
      // 老消息(>30s 前的)首次加载时不补发,避免页面打开就一堆通知
      if (Date.now() - new Date(m.createdAt).getTime() > 30_000) {
        notifiedRef.current.add(m.id)
        continue
      }
      notifiedRef.current.add(m.id)
      if (!document.hidden) continue // tab 可见时不发,用户能直接看到醒目卡片
      try {
        const n = new Notification('agent-team · 需要人类介入', {
          body: m.content,
          tag: `task-${taskId}-urgent`,
          requireInteraction: false,
        })
        n.onclick = () => {
          window.focus()
          n.close()
        }
      } catch {
        // 静默忽略(某些浏览器无 service worker 拒绝直接 new Notification)
      }
    }
  }, [allMessages, taskId])

  // seat lookups
  const seatById = useMemo(() => Object.fromEntries(seats.map((s) => [s.id, s])), [seats])
  const agentById = useMemo(() => Object.fromEntries(agents.map((a) => [a.id, a])), [agents])
  // sender prefix(planner-XXX / engineer-XXX / qa-XXX / ci-XXX)→ role
  const roleBySender = useMemo(() => {
    const map: Record<string, RoleName> = {}
    for (const a of agents) {
      map[a.id] = factoryToRoleName(a.factory)
    }
    // system 消息(编排/状态机)用 boss 皇冠头像,不再 fallback '?'
    map['system'] = 'system'
    return map
  }, [agents])
  const nameBySender = useMemo(() => {
    const map: Record<string, string> = {}
    for (const a of agents) map[a.id] = a.displayName ?? a.factory
    map['system'] = 'system'
    return map
  }, [agents])
  // sender agentId → AvatarStatus 角标 — 单点 helper(agent-presence-ui spec)
  const statusBySender = useMemo(() => {
    const map: Record<string, AvatarStatus> = {}
    for (const s of seats) {
      if (!s.currentAgentId) continue
      const a = agents.find((x) => x.id === s.currentAgentId)
      map[s.currentAgentId] = computeAvatarStatus(s, a)
    }
    return map
  }, [seats, agents])

  function openAgentProfile(agentId: string) {
    const agent = agents.find((a) => a.id === agentId)
    if (!agent) return
    openRightPanel(
      `agent-profile:${agent.id}`,
      <AgentPanel taskId={taskId} agentId={agent.id} onClose={closeRightPanel} />,
    )
  }

  function openFilePath(path: string) {
    openFileViewer({ openRightPanel, closeRightPanel }, taskId, path)
  }

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        position: 'relative',
      }}
    >
      <ChannelTabs active={activeChannel} onChange={setActiveChannel} />

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        style={{
          overflowY: 'auto',
          padding: '12px 24px',
          flex: 1,
          minHeight: 0,
        }}
      >
        {messages.length === 0 ? (
          <div
            style={{
              height: '100%',
              minHeight: 200,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--ink-dim)',
              fontSize: 12,
              letterSpacing: '0.1em',
            }}
          >
            chatroom · {activeChannel} 频道暂无消息
          </div>
        ) : (
          // agent-thinking + 紧跟 agent-text(同 sender 同 channel)合并成同一条气泡:
          // thinking 折叠在上,省略号 loading 过渡,正式内容在下。其它消息照常单条渲染。
          (() => {
            // 双向 grouping:agent-thinking + 相邻同 sender/channel 的 agent-text 合并到同一气泡
            //   方向 A:thinking 在前,text 在后(典型 codex-sdk:先 stream 后 chatroom_send)
            //   方向 B:text 在前,thinking 在后(典型 codex-sdk:先 chatroom_send 后 stream 残余)
            const rows: Array<{ key: string; msg: Message; thinking?: Message }> = []
            for (let i = 0; i < messages.length; i++) {
              const m = messages[i]
              if (!m) continue
              const next = messages[i + 1]
              const sameSenderChannel = (a: Message, b: Message) =>
                a.sender === b.sender && a.channel === b.channel
              // 方向 A:thinking → text
              if (
                m.type === 'agent-thinking' &&
                next &&
                next.type === 'agent-text' &&
                sameSenderChannel(m, next)
              ) {
                rows.push({ key: next.id, msg: next, thinking: m })
                i++
                continue
              }
              // 方向 B:text → thinking(后续 thinking 折叠成 postscript)
              if (
                m.type === 'agent-text' &&
                next &&
                next.type === 'agent-thinking' &&
                sameSenderChannel(m, next)
              ) {
                rows.push({ key: m.id, msg: m, thinking: next })
                i++
                continue
              }
              rows.push({ key: m.id, msg: m })
            }
            // feed = 已定稿消息行 + 进行中 partial 草稿,统一按"开口时间"排序后渲染。
            // partial 用 streamStart 作键 → stream 中就稳定坐在开口位置,定稿时不跳动。
            const feed: Array<{ sortKey: number; el: ReactNode }> = []
            for (const { key, msg, thinking } of rows) {
              feed.push({
                sortKey: sortKeyOf(msg),
                el: (
                  <MessageRow
                    key={key}
                    message={msg}
                    thinking={thinking}
                    role={roleBySender[msg.sender] ?? null}
                    displayName={nameBySender[msg.sender] ?? msg.sender}
                    status={statusBySender[msg.sender]}
                    onAvatarClick={() => openAgentProfile(msg.sender)}
                    onMentionAgentClick={openAgentProfile}
                    mentionContext={{ seatById, agentById }}
                    onOpenFile={openFilePath}
                    isAcked={
                      Boolean(msg.acknowledgedAt) ||
                      ackedUrgents.has(msg.id) ||
                      ackedUrgents.has(msg.urgentKey ?? urgentKeyForContent(msg.content))
                    }
                    onAckUrgent={() => ackUrgent(msg)}
                  />
                ),
              })
            }
            for (const [agentId, p] of Object.entries(partialByAgent)) {
              if (p.channel !== activeChannel || p.content.length === 0) continue
              const agent = agentById[agentId]
              feed.push({
                sortKey: streamStartRef.current.get(agentId) ?? Number.MAX_SAFE_INTEGER,
                el: (
                  <PartialBubble
                    key={`partial-${agentId}`}
                    agentId={agentId}
                    role={roleBySender[agentId] ?? null}
                    displayName={nameBySender[agentId] ?? agentId}
                    status={statusBySender[agentId]}
                    content={p.content}
                    agent={agent}
                    seat={agent?.seatId ? seatById[agent.seatId] : undefined}
                    onAvatarClick={() => openAgentProfile(agentId)}
                    onOpenFile={openFilePath}
                  />
                ),
              })
            }
            // 稳定排序(同键保留插入序:消息行在前、grouping 已配对的 thinking+text 相邻)
            feed.sort((a, b) => a.sortKey - b.sortKey)
            return feed.map((it) => it.el)
          })()
        )}
      </div>

      <ThinkingStrip seats={seats} agents={agents} messages={allMessages} />

      <SeatsBar seats={seats} agents={agents} onAgentClick={openAgentProfile} />

      <Composer
        taskId={taskId}
        channel={activeChannel}
        seats={seats}
        agents={agents}
        onMentionAgentClick={openAgentProfile}
      />
    </div>
  )
}

const ChannelTabs: FC<{ active: Channel; onChange: (c: Channel) => void }> = ({
  active,
  onChange,
}) => (
  <div
    style={{
      display: 'flex',
      gap: 0,
      borderBottom: '1px solid var(--slate-edge)',
      padding: '0 12px',
      background: 'var(--slate-bg)',
    }}
  >
    {CHANNELS.map((ch) => (
      <button
        key={ch.value}
        type="button"
        onClick={() => onChange(ch.value)}
        style={{
          background: 'transparent',
          border: 'none',
          borderBottom: `2px solid ${active === ch.value ? 'var(--cyan)' : 'transparent'}`,
          color: active === ch.value ? 'var(--cyan-bright)' : 'var(--ink-dim)',
          padding: '8px 12px',
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: '0.15em',
          textTransform: 'uppercase',
          fontFamily: 'var(--font-chrome)',
          cursor: 'pointer',
          marginBottom: -1,
          textShadow: active === ch.value ? '0 0 6px var(--cyan-glow)' : 'none',
        }}
      >
        {ch.label}
      </button>
    ))}
  </div>
)

const MessageRow: FC<{
  message: Message
  /** 紧邻的 agent-thinking,合并到同一气泡上方折叠区(同 sender 同 channel) */
  thinking?: Message
  role: RoleName | null
  displayName: string
  status?: AvatarStatus
  onAvatarClick?: () => void
  /** 点 mention chip 主体打开该 mention agent profile(独立于 sender avatar)*/
  onMentionAgentClick?: (agentId: string) => void
  mentionContext?: {
    seatById: Record<string, Seat | undefined>
    agentById: Record<string, Agent | undefined>
  }
  /** 用户已 ack 的 urgent system-event(降级为普通 sysline) */
  isAcked?: boolean
  /** 用户点 "我知道了" 触发 */
  onAckUrgent?: () => void
  onOpenFile?: (path: string) => void
}> = ({
  message,
  thinking,
  role,
  displayName,
  status,
  onAvatarClick,
  onMentionAgentClick,
  mentionContext,
  isAcked,
  onAckUrgent,
  onOpenFile,
}) => {
  // 系统事件 — 普通 sysline,异常事件用醒目卡片(用户 ack 后降级为 sysline)
  if (message.type === 'system-event') {
    if (isUrgentSystemEvent(message.content) && !isAcked) {
      return (
        <div
          role="alert"
          style={{
            margin: '14px 0',
            padding: '12px 16px',
            background: 'var(--amber)',
            color: 'var(--slate-bg)',
            border: '1px solid var(--amber)',
            borderRadius: 2,
            boxShadow: '0 0 12px var(--amber-glow), 0 0 24px rgba(255,140,46,0.3)',
            fontFamily: 'var(--font-chrome)',
            fontSize: 13,
            fontWeight: 600,
            letterSpacing: '0.05em',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <span aria-hidden="true" style={{ fontSize: 18, lineHeight: 1 }}>
            ⚠
          </span>
          <span style={{ flex: 1 }}>{message.content}</span>
          {onAckUrgent && (
            <button
              type="button"
              onClick={onAckUrgent}
              style={{
                background: 'var(--slate-bg)',
                color: 'var(--amber)',
                border: '1px solid var(--slate-bg)',
                borderRadius: 2,
                padding: '4px 12px',
                fontSize: 11,
                fontFamily: 'var(--font-chrome)',
                fontWeight: 600,
                letterSpacing: '0.08em',
                cursor: 'pointer',
                flexShrink: 0,
                transition: 'background 120ms, color 120ms',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'transparent'
                e.currentTarget.style.color = 'var(--slate-bg)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'var(--slate-bg)'
                e.currentTarget.style.color = 'var(--amber)'
              }}
            >
              我知道了
            </button>
          )}
        </div>
      )
    }
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0' }}>
        <hr className="ab-divider" style={{ flex: 1 }} />
        <span
          className="ab-hud"
          style={{
            fontSize: 10,
            color: 'var(--ink-dim)',
            letterSpacing: '0.25em',
            whiteSpace: 'nowrap',
          }}
        >
          {message.content}
        </span>
        <hr className="ab-divider" style={{ flex: 1 }} />
      </div>
    )
  }

  // 注:agent-thinking 现在走主流程渲染(头像+气泡),气泡内只有折叠思考+省略号 loading;
  // 紧邻 agent-text 时会被 ChatroomV2 grouped 进同一条 MessageRow 的 thinking prop。
  // tool-trace 极简
  if (message.type === 'tool-trace') {
    return (
      <div
        style={{
          fontSize: 14,
          lineHeight: '24px',
          color: 'var(--ink-dimmer)',
          padding: '2px 8px',
          fontFamily: 'var(--font-chrome)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
        title={message.content}
      >
        {message.content}
      </div>
    )
  }

  // human 用 Link 绿 quote 线 + ink-soft 文字
  const isHuman = message.sender === 'human'
  const roleColor = isHuman ? 'var(--link)' : role ? `var(--${role})` : 'var(--ink-soft)'

  return (
    <div
      style={{
        display: 'flex',
        gap: 12,
        padding: '14px 0',
        position: 'relative',
        ...(isHuman
          ? {
              borderLeft: '2px solid var(--link)',
              paddingLeft: 12,
              marginLeft: -14,
              boxShadow: '-2px 0 8px var(--link-glow)',
            }
          : {}),
      }}
    >
      {isHuman ? (
        <Avatar role="you" size={36} displayName="YOU" />
      ) : message.sender === 'system' ? (
        // system(编排/状态机)= boss 皇冠头像,无状态角标 / 无 click profile
        <Avatar role="system" size={36} displayName="SYSTEM" />
      ) : role ? (
        <AgentAvatar
          agent={mentionContext?.agentById[message.sender]}
          seat={
            mentionContext?.agentById[message.sender]?.seatId
              ? mentionContext?.seatById[mentionContext.agentById[message.sender]!.seatId]
              : undefined
          }
          role={role}
          displayName={displayName}
          status={status}
          onClick={onAvatarClick}
        />
      ) : (
        <span
          style={{
            width: 36,
            height: 36,
            borderRadius: '50%',
            background: 'var(--slate-elev)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--ink-dim)',
            fontSize: 11,
            flexShrink: 0,
          }}
        >
          ?
        </span>
      )}

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
          <span
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: roleColor,
              letterSpacing: '0.04em',
              textShadow: isHuman ? '0 0 4px var(--link-glow)' : 'none',
            }}
          >
            {isHuman ? 'YOU' : displayName}
          </span>
          <span
            className="ab-tabular"
            style={{ fontSize: 10, color: 'var(--ink-dim)' }}
          >
            {formatTime(message.createdAt)}
          </span>
        </div>
        <div
          style={{
            fontSize: 13,
            color: 'var(--ink-soft)',
            lineHeight: 1.6,
            wordBreak: 'break-word',
          }}
        >
          {/* thinking 折叠区:standalone thinking msg 或 grouped 时上方 */}
          {(thinking || message.type === 'agent-thinking') && (
            <ThinkingSection
              content={(thinking ?? message).content}
              hasFormal={message.type !== 'agent-thinking'}
              roleColor={roleColor}
              onOpenFile={onOpenFile}
            />
          )}
          {/* agent-thinking 类型自身没正式内容,跳过下方 markdown */}
          {message.type === 'agent-thinking' ? null : (
          <ReactMarkdown
            remarkPlugins={[remarkGfm, remarkBreaks]}
            components={chatMarkdownComponents({ onOpenFile })}
          >
            {normalizeDisplayContent(message.content)}
          </ReactMarkdown>
          )}
        </div>
        {message.mention && message.mention.length > 0 && (
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 4,
              marginTop: 6,
              alignItems: 'center',
            }}
          >
            <span
              className="ab-eyebrow"
              style={{ fontSize: 9, color: 'var(--ink-dim)' }}
            >
              mentioned →
            </span>
            {message.mention.map((mid) => {
              const s = mentionContext?.seatById[mid]
              const a = s?.currentAgentId ? mentionContext?.agentById[s.currentAgentId] : undefined
              return (
                <MentionChip
                  key={mid}
                  seat={s}
                  agent={a}
                  fallbackText={mid.slice(0, 14)}
                  onAgentClick={onMentionAgentClick}
                />
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

const SeatsBar: FC<{
  seats: Seat[]
  agents: Agent[]
  onAgentClick?: (agentId: string) => void
}> = ({ seats, agents, onAgentClick }) => {
  // 同 role 留全部 seat(不只取第一个);chip 主文字显计数
  const seatsByRole = useMemo(() => {
    const map: Record<string, Seat[]> = {}
    for (const s of seats) {
      const r = factoryToRoleName(s.factory)
      if (!map[r]) map[r] = []
      map[r].push(s)
    }
    return map
  }, [seats])
  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents])

  return (
    <div
      style={{
        display: 'flex',
        gap: 12,
        padding: '8px 16px',
        borderTop: '1px solid var(--slate-edge)',
        background: 'var(--slate-surface)',
        alignItems: 'center',
        flexWrap: 'wrap',
      }}
    >
      {SEAT_ORDER.map((role) => (
        <SeatRoleChip
          key={role}
          role={role}
          seats={seatsByRole[role] ?? []}
          agentById={agentById}
          onAgentClick={onAgentClick}
        />
      ))}
    </div>
  )
}

/**
 * 单 role chip — 色点 + role 名(+ ×N 计数)。
 * - 色点 hover:popup 显状态文案(pickDominantStatus)
 * - 名字 hover:popup 显在岗 AgentAvatar 列表;点 avatar 打开 right panel profile
 * 共享一个 popup state + 100ms 延迟关闭(chip mouseleave)
 */
const SeatRoleChip: FC<{
  role: RoleName
  seats: Seat[]
  agentById: Map<string, Agent>
  onAgentClick?: (agentId: string) => void
}> = ({ role, seats, agentById, onAgentClick }) => {
  const [popup, setPopup] = useState<null | 'status' | 'agents'>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const closeAfterDelay = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => setPopup(null), 100)
  }
  const cancelClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
  }
  useEffect(() => () => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
  }, [])

  const roleColor = `var(--${role})`
  const present = seats.length > 0
  const agentsInRole = seats
    .map((s) => (s.currentAgentId ? agentById.get(s.currentAgentId) : undefined))
    .filter((a): a is Agent => !!a)

  // 各 seat 算 status,取最活
  const dominantStatus = present
    ? pickDominantStatus(
        seats.map((s) =>
          computeAvatarStatus(s, s.currentAgentId ? agentById.get(s.currentAgentId) : undefined),
        ),
      )
    : 'vacant'
  // working / init 都属"活跃中"动效,让用户感知到正在变化
  const pulsing = dominantStatus === 'working' || dominantStatus === 'init'
  // 色点用 state 色(运行态),文字用 role 色(身份)
  const stateColor = STATUS_COLOR[dominantStatus]
  const stateGlow = STATUS_GLOW[dominantStatus]

  const label = present && seats.length > 1 ? `${role} ×${seats.length}` : role

  return (
    <span
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 8px',
        fontSize: 11,
        opacity: present ? 1 : 0.4,
        borderRadius: 2,
      }}
      onMouseLeave={closeAfterDelay}
    >
      <span
        aria-hidden="true"
        className={pulsing ? 'ab-pulse' : ''}
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: stateColor,
          boxShadow: stateGlow,
          cursor: 'help',
        }}
        onMouseEnter={() => {
          cancelClose()
          setPopup('status')
        }}
      />
      <span
        style={{
          letterSpacing: '0.06em',
          cursor: 'help',
          color: present ? roleColor : 'var(--ink-dimmer)',
          fontWeight: present ? 600 : 400,
        }}
        onMouseEnter={() => {
          cancelClose()
          setPopup('agents')
        }}
      >
        {label}
      </span>

      {popup && (
        <span
          role="tooltip"
          style={{
            position: 'absolute',
            bottom: 'calc(100% + 6px)',
            left: 0,
            zIndex: 50,
            padding: '8px 10px',
            background: 'var(--slate-elev)',
            border: `1px solid ${roleColor}`,
            borderRadius: 2,
            boxShadow: `0 4px 16px rgba(0,0,0,0.5), 0 0 8px ${roleColor}`,
            whiteSpace: 'nowrap',
            lineHeight: 1.4,
            // 让 popup 可接 mouseenter 维持开启(状态从色点/名字 hover 切回 popup 不闪)
            pointerEvents: 'auto',
          }}
          onMouseEnter={cancelClose}
        >
          {popup === 'status' ? (
            <span
              style={{
                fontSize: 11,
                color: 'var(--ink-soft)',
                letterSpacing: '0.08em',
                fontFamily: 'var(--font-chrome)',
              }}
            >
              {role.toUpperCase()} · {STATUS_LABEL[dominantStatus]}
            </span>
          ) : agentsInRole.length === 0 ? (
            <span
              style={{
                fontSize: 11,
                color: dominantStatus === 'init' ? 'var(--link)' : 'var(--ink-dim)',
                fontStyle: dominantStatus === 'init' ? 'normal' : 'italic',
                fontFamily: 'var(--font-chrome)',
              }}
            >
              {present ? STATUS_LABEL[dominantStatus] : '未招募'}
            </span>
          ) : (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              {agentsInRole.map((a) => {
                const s = seats.find((x) => x.currentAgentId === a.id)
                return (
                  <AgentAvatar
                    key={a.id}
                    agent={a}
                    seat={s}
                    size={28}
                    disableHoverCard
                    onClick={onAgentClick ? () => onAgentClick(a.id) : null}
                  />
                )
              })}
            </span>
          )}
        </span>
      )}
    </span>
  )
}

const Composer: FC<{
  taskId: string
  channel: Channel
  seats: Seat[]
  agents: Agent[]
  onMentionAgentClick?: (agentId: string) => void
}> = ({ taskId, channel, seats, agents, onMentionAgentClick }) => {
  const queryClient = useQueryClient()
  const agentById = useMemo(
    () => Object.fromEntries(agents.map((a) => [a.id, a])),
    [agents],
  )
  const [content, setContent] = useState('')
  const [showMention, setShowMention] = useState(false)
  const [mentionFilter, setMentionFilter] = useState('')
  const [mentions, setMentions] = useState<string[]>([])
  const [mentionHover, setMentionHover] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const mentionItemRefs = useRef<Record<number, HTMLButtonElement | null>>({})

  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    const maxHeight = 205
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, maxHeight)}px`
    ta.style.overflowY = ta.scrollHeight > maxHeight ? 'auto' : 'hidden'
  }, [content])

  function handleChange(value: string) {
    setContent(value)
    const ta = textareaRef.current
    if (!ta) return
    const caret = ta.selectionStart
    const before = value.slice(0, caret)
    const atMatch = before.match(/@([a-z0-9-]*)$/i)
    if (atMatch) {
      setShowMention(true)
      setMentionFilter(atMatch[1] ?? '')
    } else {
      setShowMention(false)
    }
  }

  function pickMention(seat: Seat) {
    if (!mentions.includes(seat.id)) {
      setMentions((prev) => [...prev, seat.id])
    }
    // 删除 textarea 里的 @partial
    const ta = textareaRef.current
    if (ta) {
      const caret = ta.selectionStart
      const before = content.slice(0, caret).replace(/@[a-z0-9-]*$/i, `@${seat.role} `)
      const after = content.slice(caret)
      setContent(before + after)
      setTimeout(() => {
        ta.focus()
        ta.setSelectionRange(before.length, before.length)
      }, 0)
    }
    setShowMention(false)
  }

  function send() {
    const trimmed = content.trim()
    if (!trimmed) return
    // 乐观更新:本地立即 append 一条 human-msg(用 temp id),WS 回声来 dedup,
    // 不来(task-process 未 alive 等场景)至少 UI 有反馈。
    // M1 qa geba 抓的"输入回显"bug root cause = server 重启 task-process 没起;
    // 这里前端先稳住,后端 launcher 自动唤醒 task-process 留 polish。
    const tempId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const now = new Date().toISOString()
    queryClient.setQueryData<Message[]>(['messages', taskId], (prev = []) => [
      ...prev,
      {
        id: tempId,
        taskId,
        channel,
        type: 'human-msg',
        sender: 'human',
        content: trimmed,
        mention: mentions,
        refs: [],
        replyTo: null,
        createdAt: now,
      } as Message,
    ])
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
    // mention picker 优先吃键
    if (showMention && filteredSeats.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setMentionHover((h) => (h + 1) % filteredSeats.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setMentionHover((h) => (h - 1 + filteredSeats.length) % filteredSeats.length)
        return
      }
      if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        const target = filteredSeats[mentionHover] ?? filteredSeats[0]
        if (target) pickMention(target)
        return
      }
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      send()
    }
    if (e.key === 'Escape' && showMention) {
      setShowMention(false)
    }
  }

  const filteredSeats = useMemo(() => {
    const q = mentionFilter.toLowerCase()
    return seats.filter(
      (s) => s.status !== 'vacant' && (q === '' || s.role.toLowerCase().includes(q) || s.factory.toLowerCase().includes(q)),
    )
  }, [seats, mentionFilter])

  // 高亮重置:filter / picker 开关变 → 第一项
  useEffect(() => {
    setMentionHover(0)
  }, [mentionFilter, showMention])

  useEffect(() => {
    if (!showMention) return
    mentionItemRefs.current[mentionHover]?.scrollIntoView({ block: 'nearest' })
  }, [mentionHover, showMention])

  return (
    <div
      style={{
        position: 'relative',
        borderTop: '1px solid var(--slate-edge)',
        boxShadow: '0 -1px 0 var(--cyan-dim)',
        background: 'var(--slate-bg)',
        padding: 12,
      }}
    >
      {mentions.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
          {mentions.map((mid) => {
            const s = seats.find((x) => x.id === mid)
            const a = s?.currentAgentId ? agentById[s.currentAgentId] : undefined
            return (
              <MentionChip
                key={mid}
                seat={s}
                agent={a}
                fallbackText={s?.role ?? mid}
                onRemove={() => setMentions((prev) => prev.filter((id) => id !== mid))}
                onAgentClick={onMentionAgentClick}
              />
            )
          })}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
        <span style={{ color: 'var(--cyan)', fontSize: 16, fontWeight: 600, padding: '6px 4px 0' }}>
          ›
        </span>
        <textarea
          ref={textareaRef}
          value={content}
          onChange={(e) => handleChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="输入消息… @ 提席位,Cmd+Enter 发送"
          rows={3}
          style={{
            flex: 1,
            minHeight: 69,
            maxHeight: 205,
            padding: '6px 8px',
            background: 'transparent',
            border: 'none',
            outline: 'none',
            color: 'var(--ink-white)',
            fontSize: 13,
            fontFamily: 'var(--font-chrome)',
            resize: 'none',
            lineHeight: 1.5,
          }}
        />
        <button
          type="button"
          onClick={send}
          disabled={!content.trim()}
          style={{
            background: content.trim()
              ? 'linear-gradient(180deg, rgba(91,200,221,0.18), rgba(91,200,221,0.06))'
              : 'transparent',
            border: `1px solid ${content.trim() ? 'var(--cyan)' : 'var(--slate-edge)'}`,
            color: content.trim() ? 'var(--cyan-bright)' : 'var(--ink-dim)',
            padding: '6px 12px',
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: '0.2em',
            textTransform: 'uppercase',
            borderRadius: 2,
            cursor: content.trim() ? 'pointer' : 'not-allowed',
            boxShadow: content.trim() ? '0 0 10px var(--cyan-glow)' : 'none',
            fontFamily: 'var(--font-chrome)',
          }}
        >
          发送
        </button>
      </div>

      {showMention && filteredSeats.length > 0 && (
        <div
          style={{
            position: 'absolute',
            bottom: '100%',
            left: 12,
            marginBottom: 4,
            background: 'var(--slate-elev)',
            border: '1px solid var(--cyan-dim)',
            borderRadius: 2,
            minWidth: 240,
            maxHeight: 200,
            overflowY: 'auto',
            zIndex: 20,
            boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
          }}
        >
          <div
            className="ab-eyebrow"
            style={{
              padding: '6px 10px',
              borderBottom: '1px solid var(--slate-edge)',
              color: 'var(--cyan)',
            }}
          >
            @ 提及席位 {mentionFilter && `· "${mentionFilter}"`}
          </div>
          {filteredSeats.map((s, idx) => {
            const isActive = idx === mentionHover
            return (
            <button
              key={s.id}
              ref={(el) => {
                mentionItemRefs.current[idx] = el
              }}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onMouseMove={() => {
                if (idx !== mentionHover) setMentionHover(idx)
              }}
              onClick={() => pickMention(s)}
              style={{
                display: 'flex',
                width: '100%',
                alignItems: 'center',
                gap: 6,
                background: isActive ? 'rgba(91,200,221,0.15)' : 'transparent',
                borderTop: 'none',
                borderRight: 'none',
                borderBottom: 'none',
                borderLeft: `2px solid ${isActive ? 'var(--cyan)' : 'transparent'}`,
                color: 'var(--ink-white)',
                padding: '6px 10px 6px 8px',
                cursor: 'pointer',
                fontFamily: 'var(--font-chrome)',
                fontSize: 12,
                textShadow: isActive ? '0 0 4px var(--cyan-glow)' : 'none',
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: `var(--${factoryToRoleName(s.factory)})`,
                  boxShadow: `0 0 4px var(--${factoryToRoleName(s.factory)})`,
                  flexShrink: 0,
                }}
              />
              <span style={{ color: 'var(--cyan-bright)' }}>@{s.role}</span>
              <span style={{ color: 'var(--ink-dim)', fontSize: 10 }}>({s.factory})</span>
            </button>
            )
          })}
        </div>
      )}
    </div>
  )
}


/**
 * ThinkingStrip — 显示所有当前 working 的 agent,每行一条 ghost row:
 *   [● role 色] {displayName} 思考中… {elapsed_s}s · {最近工具名}
 * 解决"agent mid-turn 用户感受不到进展"的痛点。
 *
 * elapsed 起点:状态从非 working → working 那一刻 client-side 记录;
 * tick:setInterval 1s 强制 re-render(仅在有 working agent 时启动)。
 */
/**
 * 流式 partial 气泡 — turn 进行中的 agent stream text 草稿。
 * UI 极简:头像 + displayName + 简化展示(纯 markdown,无 thinking 折叠) + 末尾 ▍光标。
 * done 时被正式 chatroom-msg 替换(WS handler 清 partial state)。
 */
const PartialBubble: FC<{
  agentId: string
  role: RoleName | null
  displayName: string
  status?: AvatarStatus
  content: string
  agent?: Agent
  seat?: Seat
  onAvatarClick?: () => void
  onOpenFile?: (path: string) => void
}> = ({ role, displayName, status, content, agent, seat, onAvatarClick, onOpenFile }) => {
  const colorVar = role ? `var(--${role})` : 'var(--ink-soft)'
  return (
    <div
      style={{
        display: 'flex',
        gap: 12,
        padding: '14px 0',
        position: 'relative',
        opacity: 0.85,
      }}
    >
      {role ? (
        <AgentAvatar
          agent={agent}
          seat={seat}
          role={role}
          status={status}
          displayName={displayName}
          onClick={onAvatarClick}
        />
      ) : (
        <span
          style={{
            width: 36,
            height: 36,
            borderRadius: '50%',
            background: 'var(--slate-elev)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--ink-dim)',
            fontSize: 11,
            flexShrink: 0,
          }}
        >
          ?
        </span>
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
          <span
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: colorVar,
              letterSpacing: '0.04em',
            }}
          >
            {displayName}
          </span>
          <span
            className="ab-eyebrow ab-tabular"
            style={{ fontSize: 9, color: 'var(--ink-dim)', letterSpacing: '0.1em' }}
          >
            streaming…
          </span>
        </div>
        <div
          style={{
            fontSize: 13,
            color: 'var(--ink-soft)',
            lineHeight: 1.6,
            wordBreak: 'break-word',
          }}
        >
          <ReactMarkdown
            remarkPlugins={[remarkGfm, remarkBreaks]}
            components={chatMarkdownComponents({ onOpenFile })}
          >
            {content}
          </ReactMarkdown>
          <span
            className="ab-blink"
            aria-hidden="true"
            style={{ display: 'inline-block', marginLeft: 2, color: colorVar }}
          >
            ▍
          </span>
        </div>
      </div>
    </div>
  )
}

const ThinkingStrip: FC<{ seats: Seat[]; agents: Agent[]; messages: Message[] }> = ({
  seats,
  agents,
  messages,
}) => {
  const startedRef = useRef<Map<string, number>>(new Map())
  const [, force] = useState(0)

  const working = useMemo(
    () => seats.filter((s) => s.status === 'working' && s.currentAgentId),
    [seats],
  )

  // 同步 startedRef:新 working 起记 now;走出 working 删。
  // (之前尝试"从上一次活动时间续算",但 messages 时间 ≠ turn 起点,误差大,体感差,撤回)
  useEffect(() => {
    const now = Date.now()
    const workingIds = new Set(working.map((s) => s.id))
    for (const s of working) {
      if (!startedRef.current.has(s.id)) startedRef.current.set(s.id, now)
    }
    for (const id of [...startedRef.current.keys()]) {
      if (!workingIds.has(id)) startedRef.current.delete(id)
    }
  }, [working])

  // 1s tick — 仅当至少一个 working
  useEffect(() => {
    if (working.length === 0) return
    const t = setInterval(() => force((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [working.length])

  // 每个 agent 的最近 tool-trace(取 name 部分,去掉 mcp__xxx__ 前缀)
  const lastToolByAgent = useMemo(() => {
    const map = new Map<string, string>()
    for (let i = messages.length - 1; i >= 0 && map.size < 32; i--) {
      const m = messages[i]
      if (m && m.type === 'tool-trace' && !map.has(m.sender)) {
        const match = m.content.match(/🔧\s*([^\s{]+)/)
        if (match && match[1]) {
          const name = match[1].replace(/^mcp__[^_]+__/, '')
          map.set(m.sender, name)
        }
      }
    }
    return map
  }, [messages])

  if (working.length === 0) return null

  return (
    <div
      style={{
        borderTop: '1px solid var(--slate-divide)',
        background: 'var(--slate-bg)',
        padding: '6px 24px',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
    >
      {working.map((seat) => {
        const agent = agents.find((a) => a.id === seat.currentAgentId)
        const role = agent ? factoryToRoleName(agent.factory) : null
        const startedAt = startedRef.current.get(seat.id) ?? Date.now()
        const elapsed = formatElapsed(Math.floor((Date.now() - startedAt) / 1000))
        const tool = agent ? lastToolByAgent.get(agent.id) : undefined
        const colorVar = role ? `var(--${role})` : 'var(--ink-dim)'
        return (
          <div
            key={seat.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 11,
              color: 'var(--ink-dim)',
              fontFamily: 'var(--font-chrome)',
              letterSpacing: '0.04em',
            }}
          >
            <span
              className="ab-pulse"
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: 'var(--amber)',
                boxShadow: '0 0 6px var(--amber-glow)',
                flexShrink: 0,
              }}
            />
            <span style={{ color: colorVar, fontWeight: 600 }}>
              {agent?.displayName ?? seat.role}
            </span>
            <span style={{ opacity: 0.85 }}>思考中…</span>
            <span className="ab-tabular" style={{ color: 'var(--ink-soft)' }}>
              {elapsed}
            </span>
            {tool && (
              <>
                <span style={{ opacity: 0.4 }}>·</span>
                <span
                  style={{
                    color: 'var(--ink-soft)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    maxWidth: 240,
                  }}
                >
                  {tool}
                </span>
              </>
            )}
          </div>
        )
      })}
    </div>
  )
}

/**
 * ThinkingSection — 嵌进 agent 气泡内的折叠思考流块。
 * - 默认折叠成 "▸ 思考流" 小按钮(点击展开看完整 markdown)
 * - hasFormal=true(下方有正式回复)时,在思考块和正式内容之间渲染 thinking-dots loading 过渡
 * - hasFormal=false(纯 thinking,无正式回复)时,不渲染过渡 dots
 */
const ThinkingSection: FC<{
  content: string
  hasFormal: boolean
  roleColor: string
  onOpenFile?: (path: string) => void
}> = ({ content, hasFormal, roleColor, onOpenFile }) => {
  // 有正式文本时思考默认折叠(正式内容才是主体);思考独立成条(无正式文本)默认展开,
  // 否则整条只剩一个"▸思考流"按钮、内容全藏起来 → 体感"信息没了"。
  const [expanded, setExpanded] = useState(!hasFormal)
  return (
    <div style={{ marginBottom: hasFormal ? 6 : 0 }}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        style={{
          all: 'unset',
          cursor: 'pointer',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          padding: '2px 6px',
          fontSize: 11,
          color: 'var(--ink-dim)',
          fontFamily: 'var(--font-chrome)',
          border: `1px dashed ${roleColor}`,
          borderRadius: 2,
        }}
      >
        <span style={{ color: roleColor, fontSize: 10 }}>{expanded ? '▾' : '▸'}</span>
        <span style={{ color: roleColor, letterSpacing: '0.04em' }}>思考流</span>
      </button>
      {expanded && (
        <div
          style={{
            marginTop: 4,
            paddingLeft: 10,
            borderLeft: '2px solid var(--slate-edge)',
            fontSize: 12,
            color: 'var(--ink-dim)',
            lineHeight: 1.55,
            wordBreak: 'break-word',
          }}
        >
          <ReactMarkdown
            remarkPlugins={[remarkGfm, remarkBreaks]}
            components={chatMarkdownComponents({
              onOpenFile,
              compact: true,
              quoteColor: roleColor,
            })}
          >
            {normalizeDisplayContent(content)}
          </ReactMarkdown>
        </div>
      )}
    </div>
  )
}

function chatMarkdownComponents(opts: {
  onOpenFile?: (path: string) => void
  compact?: boolean
  quoteColor?: string
}): Components {
  const compact = opts.compact ?? false
  const codeBg = compact ? 'var(--slate-bg)' : 'var(--slate-elev)'
  return {
    p: ({ children }) => <p style={{ margin: compact ? '0 0 6px' : '0 0 8px' }}>{children}</p>,
    h1: ({ children }) => (
      <h1 style={{ margin: '12px 0 6px', fontSize: compact ? 13 : 16, fontWeight: 700, color: 'var(--ink-white)' }}>
        {children}
      </h1>
    ),
    h2: ({ children }) => (
      <h2 style={{ margin: '10px 0 6px', fontSize: compact ? 12 : 15, fontWeight: 700, color: 'var(--ink-white)' }}>
        {children}
      </h2>
    ),
    h3: ({ children }) => (
      <h3 style={{ margin: '10px 0 4px', fontSize: compact ? 12 : 14, fontWeight: 600, color: 'var(--ink-white)' }}>
        {children}
      </h3>
    ),
    h4: ({ children }) => (
      <h4 style={{ margin: '8px 0 4px', fontSize: 13, fontWeight: 600, color: 'var(--ink-soft)' }}>
        {children}
      </h4>
    ),
    strong: ({ children }) => <strong style={{ fontWeight: 700, color: 'var(--ink-white)' }}>{children}</strong>,
    em: ({ children }) => <em style={{ fontStyle: 'italic', color: 'var(--ink-soft)' }}>{children}</em>,
    ul: ({ children }) => <ul style={{ margin: '4px 0 8px', paddingLeft: compact ? 18 : 20 }}>{children}</ul>,
    ol: ({ children }) => <ol style={{ margin: '4px 0 8px', paddingLeft: compact ? 18 : 20 }}>{children}</ol>,
    li: ({ children }) => <li style={{ margin: '2px 0' }}>{children}</li>,
    blockquote: ({ children }) => (
      <blockquote
        style={{
          margin: compact ? '4px 0' : '6px 0',
          paddingLeft: compact ? 8 : 10,
          borderLeft: `2px solid ${opts.quoteColor ?? 'var(--cyan-dim)'}`,
          color: 'var(--ink-dim)',
        }}
      >
        {children}
      </blockquote>
    ),
    hr: () => <hr className="ab-divider" style={{ margin: '8px 0' }} />,
    table: ({ children }) => (
      <table style={{ borderCollapse: 'collapse', margin: '6px 0', fontSize: 12 }}>{children}</table>
    ),
    th: ({ children }) => (
      <th
        style={{
          border: '1px solid var(--slate-edge)',
          padding: '4px 8px',
          background: 'var(--slate-elev)',
          textAlign: 'left',
          color: 'var(--ink-white)',
        }}
      >
        {children}
      </th>
    ),
    td: ({ children }) => (
      <td style={{ border: '1px solid var(--slate-edge)', padding: '4px 8px' }}>{children}</td>
    ),
    code: ({ children, className }) => {
      const text = String(children).replace(/\n$/, '')
      if (!className && opts.onOpenFile && isInlineFilePath(text)) {
        return (
          <button
            type="button"
            onClick={() => opts.onOpenFile?.(text)}
            style={{
              background: codeBg,
              border: '1px solid var(--cyan-dim)',
              padding: '1px 4px',
              borderRadius: 2,
              fontSize: compact ? 11 : 12,
              color: 'var(--cyan-bright)',
              cursor: 'pointer',
              fontFamily: 'var(--font-chrome)',
            }}
          >
            {children}
          </button>
        )
      }
      return (
        <code
          className={className}
          style={{
            background: codeBg,
            padding: '1px 4px',
            borderRadius: 2,
            fontSize: compact ? 11 : 12,
            color: 'var(--cyan-bright)',
          }}
        >
          {children}
        </code>
      )
    },
    pre: ({ children }) => (
      <pre
        style={{
          background: codeBg,
          border: '1px solid var(--slate-edge)',
          padding: compact ? 6 : 8,
          overflow: 'auto',
          fontSize: 11,
          borderRadius: 2,
          margin: compact ? '4px 0' : undefined,
        }}
      >
        {children}
      </pre>
    ),
    a: ({ children, href }) => {
      if (opts.onOpenFile && isLocalFileHref(href)) {
        return (
          <button
            type="button"
            onClick={() => opts.onOpenFile?.(href)}
            style={{
              all: 'unset',
              color: 'var(--cyan)',
              textDecoration: 'underline',
              cursor: 'pointer',
            }}
          >
            {children}
          </button>
        )
      }
      return (
        <a
          href={href}
          style={{ color: 'var(--cyan)', textDecoration: 'underline' }}
          target="_blank"
          rel="noreferrer"
        >
          {children}
        </a>
      )
    },
  }
}

function normalizeDisplayContent(content: string): string {
  return content.replace(/\\n/g, '\n')
}

/** 思考中计时:秒数 → hh:mm:ss(>=1h);<1h 显 mm:ss;<1min 显 0:ss */
function formatElapsed(totalSec: number): string {
  const s = Math.max(0, totalSec)
  const hh = Math.floor(s / 3600)
  const mm = Math.floor((s % 3600) / 60)
  const ss = s % 60
  const pad = (n: number) => n.toString().padStart(2, '0')
  if (hh > 0) return `${hh}:${pad(mm)}:${pad(ss)}`
  return `${mm}:${pad(ss)}`
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  return d.toTimeString().slice(0, 8)
}

/**
 * MentionChip — @ 提及徽章,hover 显示 agent 名片(Avatar / displayName /
 * role · factory v? / status)。两处复用:Composer 已选 mention 显示;
 * MessageRow mention 列表 footer。
 *
 * 单独的小 absolute 浮层(parent relative),不引依赖。
 */
const MentionChip: FC<{
  seat?: Seat
  agent?: Agent
  fallbackText: string
  onRemove?: () => void
  /** 点 chip 主体打开 agent profile(仅 agent 存在时生效)*/
  onAgentClick?: (agentId: string) => void
}> = ({ seat, agent, fallbackText, onRemove, onAgentClick }) => {
  const [hover, setHover] = useState(false)
  const role = seat ? factoryToRoleName(seat.factory) : null
  const colorVar = role ? `var(--${role})` : 'var(--ink-dim)'
  // 统一走 computeAvatarStatus + STATUS_COLOR(跟 SeatsBar / Avatar 同一套语义),
  // 不再 ad-hoc(之前 vacant 错误映射成红 malice,跟 SeatsBar "空位=灰" 不一致)
  const status = computeAvatarStatus(seat, agent)
  const statusColor = STATUS_COLOR[status]
  return (
    <span
      style={{ position: 'relative', display: 'inline-flex' }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <span
        role={onAgentClick && agent ? 'button' : undefined}
        tabIndex={onAgentClick && agent ? 0 : undefined}
        onClick={
          onAgentClick && agent
            ? (e) => {
                e.stopPropagation()
                onAgentClick(agent.id)
              }
            : undefined
        }
        onKeyDown={
          onAgentClick && agent
            ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onAgentClick(agent.id)
                }
              }
            : undefined
        }
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          padding: '2px 6px',
          background: 'rgba(91,200,221,0.12)',
          border: `1px solid ${role ? colorVar : 'var(--cyan-dim)'}`,
          color: role ? colorVar : 'var(--cyan-bright)',
          fontSize: 10,
          borderRadius: 2,
          cursor: onAgentClick && agent ? 'pointer' : 'default',
        }}
      >
        <span
          aria-hidden="true"
          className={status === 'working' || status === 'init' ? 'ab-pulse' : ''}
          style={{
            width: 5,
            height: 5,
            borderRadius: '50%',
            background: statusColor,
            boxShadow: `0 0 3px ${statusColor}`,
            flexShrink: 0,
          }}
        />
        @{agent?.displayName ?? seat?.role ?? fallbackText}
        {onRemove && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onRemove()
            }}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--ink-dim)',
              cursor: 'pointer',
              padding: 0,
              fontSize: 11,
              lineHeight: 1,
            }}
            aria-label="移除"
          >
            ×
          </button>
        )}
      </span>

      {hover && (seat || agent) && (
        <span
          role="tooltip"
          style={{
            position: 'absolute',
            bottom: 'calc(100% + 6px)',
            left: 0,
            zIndex: 50,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: 8,
            background: 'var(--slate-elev)',
            border: `1px solid ${colorVar}`,
            borderRadius: 2,
            boxShadow: `0 4px 16px rgba(0,0,0,0.5), 0 0 8px ${colorVar}`,
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
          }}
        >
          {role && (
            <AgentAvatar
              agent={agent}
              seat={seat}
              role={role}
              size={32}
              disableHoverCard
              onClick={null}
            />
          )}
          <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span
              style={{
                fontSize: 12,
                color: colorVar,
                fontWeight: 600,
                textShadow: `0 0 4px ${colorVar}`,
              }}
            >
              {agent?.displayName ?? seat?.role ?? fallbackText}
            </span>
            <span
              className="ab-eyebrow ab-tabular"
              style={{ fontSize: 9, color: 'var(--ink-dim)' }}
            >
              {seat?.role ?? '?'} · {seat?.factory ?? '?'}
              {agent?.factoryVersion ? ` v${agent.factoryVersion}` : ''} · {status}
            </span>
          </span>
        </span>
      )}
    </span>
  )
}

type AgentTab = 'meta' | 'model' | 'progress'

/**
 * Agent profile panel — 点 seat 或 message avatar 展开到框架层 right panel。
 * 内容分 tab:META(身份基本信息)/ MODEL(provider/model 详情)。
 * factory.lock.yaml snapshot / 历史 task tab 留 T-next。
 */
const AgentPanel: FC<{ taskId: string; agentId: string; onClose: () => void }> = ({
  taskId,
  agentId,
  onClose,
}) => {
  const { data: agents = [] } = useQuery<Agent[]>({
    queryKey: ['agents', taskId],
    queryFn: () => restClient.get<Agent[]>(`/tasks/${taskId}/agents`),
  })
  const { data: seats = [] } = useQuery<Seat[]>({
    queryKey: ['seats', taskId],
    queryFn: async () => normalizeSeats(await restClient.get<Seat[]>(`/tasks/${taskId}/seats`)),
  })
  const { data: messages = [] } = useQuery<Message[]>({
    queryKey: ['messages', taskId],
    queryFn: () => restClient.get<Message[]>(`/tasks/${taskId}/messages`),
  })
  const { data: usage } = useQuery<AgentUsageResponse>({
    queryKey: ['agent-usage', taskId, agentId],
    queryFn: () => restClient.get<AgentUsageResponse>(`/tasks/${taskId}/agents/${agentId}/usage`),
  })
  const agent = agents.find((a) => a.id === agentId)
  const seat = agent ? seats.find((s) => s.id === agent.seatId) : undefined
  const modelProfile = agent?.modelProfile
  const [activeTab, setActiveTab] = useState<AgentTab>('meta')

  if (!agent) {
    return (
      <div
        className="paper-panel"
        style={{
          height: '100%',
          minHeight: 0,
          borderRadius: 0,
          border: 'none',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div
          className="paper-head"
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '12px 16px',
          }}
        >
          <div className="paper-head-title">agent profile</div>
          <button type="button" onClick={onClose} aria-label="关闭" className="paper-close">
            ×
          </button>
        </div>
        <div className="paper-body" style={{ padding: '18px 20px', overflowY: 'auto', flex: 1 }}>
          <span style={{ fontSize: 14, color: 'var(--ink-brown-d)', fontStyle: 'italic' }}>
            (agent 已不存在或尚未加载)
          </span>
        </div>
      </div>
    )
  }

  const role = factoryToRoleName(agent.factory)
  const avatarStatus = computeAvatarStatus(seat, agent)
  const progressItems = messages
    .filter((message) => message.sender === agent.id)
    .filter((message) => message.type === 'agent-text' || message.type === 'tool-trace')
    .slice(-24)

  // sticky-bottom:贴底时新消息自动滚到底;用户上滚后停滚;再次回到底部恢复自动滚。
  // 只在 progress tab 生效;ref 而非 state,避免每次滚动 re-render。
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  const prevTabRef = useRef(activeTab)
  const handleScroll = () => {
    const el = scrollRef.current
    if (!el) return
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32
  }
  useEffect(() => {
    if (activeTab !== 'progress') {
      prevTabRef.current = activeTab
      return
    }
    // 切回 progress tab 时强制重置 stick=true 再滚底;同 tab 内 progressItems 变化
    // 走原有 stick 判断
    if (prevTabRef.current !== 'progress') stickRef.current = true
    prevTabRef.current = activeTab
    const el = scrollRef.current
    if (!el) return
    if (stickRef.current) {
      // requestAnimationFrame 确保 DOM 已渲染 progress tab 内容
      requestAnimationFrame(() => {
        if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
      })
    }
    // 依赖含最后一条 id:progressItems 被 slice(-24) 截断后 length 恒为 24,
    // 只靠 length 会漏掉"满 24 条后新内容到达"→ 不再自动滚底。最后一条 id 变化能补触发。
  }, [activeTab, progressItems.length, progressItems.at(-1)?.id])

  return (
    <div
      className="paper-panel"
      style={{
        height: '100%',
        minHeight: 0,
        borderRadius: 0,
        border: 'none',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        className="paper-head"
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '12px 16px',
        }}
      >
        <div className="paper-head-title">
          agent profile
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭"
          className="paper-close"
        >
          ×
        </button>
      </div>

      {/* Avatar 卡 + TabBar 跟 header 一起置顶,不参与滚动 */}
      <div style={{ padding: '0 20px', flexShrink: 0 }}>
        <div
          style={{
            display: 'flex',
            gap: 12,
            alignItems: 'center',
            paddingTop: 16,
            paddingBottom: 14,
            borderBottom: '1px solid var(--paper-shadow)',
          }}
        >
          <AgentAvatar
            agent={agent}
            seat={seat}
            role={role}
            size={56}
            status={avatarStatus}
            disableHoverCard
            onClick={null}
          />
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                fontSize: 22,
                fontWeight: 600,
                color: 'var(--paper-deep)',
                fontFamily: 'var(--font-paper)',
                fontVariant: 'small-caps',
                letterSpacing: '0.04em',
              }}
            >
              {agent.displayName}
            </div>
            <div className="ab-eyebrow" style={{ fontSize: 10, marginTop: 4 }}>
              {role.toUpperCase()} · v{agent.factoryVersion}
              {seat && ` · ${seat.status}`}
            </div>
          </div>
        </div>

        <div style={{ paddingTop: 14 }}>
          <AgentSheetTabBar
            tabs={[
              { value: 'meta', label: 'META' },
              { value: 'model', label: 'MODEL' },
              { value: 'progress', label: `PROGRESS (${progressItems.length})` },
            ]}
            active={activeTab}
            onChange={(v) => setActiveTab(v as AgentTab)}
          />
        </div>
      </div>

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="paper-body"
        style={{ padding: '14px 20px 18px', overflowY: 'auto', flex: 1, minHeight: 0 }}
      >
          <div>
            {activeTab === 'meta' && (
              <dl
                style={{
                  display: 'grid',
                  gridTemplateColumns: '76px 1fr',
                  gap: '7px 10px',
                  margin: 0,
                  fontSize: 14,
                }}
              >
                <dt className="ab-eyebrow">id</dt>
                <dd className="ab-tabular" style={{ margin: 0, wordBreak: 'break-all' }}>
                  {agent.id}
                </dd>
                <dt className="ab-eyebrow">factory</dt>
                <dd style={{ margin: 0 }}>
                  <a href={`/factories/${agent.factory}`}>
                    {agent.factory} v{agent.factoryVersion} ↗
                  </a>
                </dd>
                {seat && (
                  <>
                    <dt className="ab-eyebrow">seat</dt>
                    <dd style={{ margin: 0 }}>
                      {seat.role}{' '}
                      <span style={{ color: 'var(--ink-brown-d)' }}>({seat.status})</span>
                    </dd>
                  </>
                )}
                <dt className="ab-eyebrow">spawned</dt>
                <dd className="ab-tabular" style={{ margin: 0 }}>
                  {new Date(agent.spawnedAt).toLocaleString('zh-CN', { hour12: false })}
                </dd>
                <dt className="ab-eyebrow">state</dt>
                <dd style={{ margin: 0 }}>{agent.state}</dd>
                <dt className="ab-eyebrow">tokens</dt>
                <dd className="ab-tabular" style={{ margin: 0 }}>
                  {formatTokenCount(usage?.runtime.totalTokens ?? 0)}
                </dd>
              </dl>
            )}

            {activeTab === 'model' && (
              <dl
                style={{
                  display: 'grid',
                  gridTemplateColumns: '90px 1fr',
                  gap: '7px 10px',
                  margin: 0,
                  fontSize: 14,
                }}
              >
                {modelProfile ? (
                  <>
                    <dt className="ab-eyebrow">provider</dt>
                    <dd style={{ margin: 0 }}>{modelProfile.provider}</dd>
                    {modelProfile.model && (
                      <>
                        <dt className="ab-eyebrow">model</dt>
                        <dd style={{ margin: 0 }}>{modelProfile.model}</dd>
                      </>
                    )}
                    {modelProfile.cliBinary && (
                      <>
                        <dt className="ab-eyebrow">cli</dt>
                        <dd
                          className="ab-tabular"
                          style={{ margin: 0, wordBreak: 'break-all' }}
                        >
                          {modelProfile.cliBinary}
                        </dd>
                      </>
                    )}
                    {modelProfile.reasoningEffort && (
                      <>
                        <dt className="ab-eyebrow">effort</dt>
                        <dd style={{ margin: 0 }}>{modelProfile.reasoningEffort}</dd>
                      </>
                    )}
                  </>
                ) : (
                  <span
                    style={{
                      gridColumn: 'span 2',
                      fontSize: 14,
                      color: 'var(--ink-brown-d)',
                      fontStyle: 'italic',
                    }}
                  >
                    (model profile 未记录)
                  </span>
                )}
                {agent.terminatedAt && (
                  <>
                    <dt className="ab-eyebrow">terminated</dt>
                    <dd className="ab-tabular" style={{ margin: 0 }}>
                      {new Date(agent.terminatedAt).toLocaleString('zh-CN', { hour12: false })}
                    </dd>
                  </>
                )}
              </dl>
            )}

            {activeTab === 'progress' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {progressItems.length === 0 ? (
                  <span
                    style={{
                      fontSize: 14,
                      color: 'var(--ink-brown-d)',
                      fontStyle: 'italic',
                    }}
                  >
                    (暂无思考内容或工具调用)
                  </span>
                ) : (
                  progressItems.map((message) => {
                    const isTool = message.type === 'tool-trace'
                    return (
                      <div
                        key={message.id}
                        style={{
                          padding: '8px 9px',
                          borderLeft: `2px solid ${isTool ? 'var(--paper-shadow)' : 'var(--paper-deep)'}`,
                          background: isTool ? 'rgba(83, 58, 24, 0.06)' : 'rgba(255, 248, 214, 0.18)',
                        }}
                      >
                        <div
                          className="ab-eyebrow ab-tabular"
                          style={{
                            fontSize: 9,
                            color: 'var(--ink-brown-d)',
                            marginBottom: 4,
                          }}
                        >
                          {isTool ? 'tool' : message.channel} · {formatTime(message.createdAt)}
                        </div>
                        <div
                          style={{
                            color: 'var(--ink-brown)',
                            fontSize: isTool ? 12 : 13,
                            lineHeight: 1.45,
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-word',
                            fontFamily: isTool ? 'var(--font-chrome)' : undefined,
                          }}
                        >
                          {message.content}
                        </div>
                      </div>
                    )
                  })
                )}
              </div>
            )}
          </div>

          <hr className="paper-rule" style={{ margin: '18px 0 12px' }} />
          <p
            style={{
              fontSize: 13,
              color: 'var(--ink-brown-d)',
              fontStyle: 'italic',
              margin: 0,
            }}
          >
            factory.lock.yaml snapshot · 历史 task 留 T-next
          </p>
      </div>
    </div>
  )
}

/** AgentSheet tab bar — 复刻 task-page.tsx TabBar 的样式(避免跨包 import) */
const AgentSheetTabBar: FC<{
  tabs: { value: string; label: string }[]
  active: string
  onChange: (v: string) => void
}> = ({ tabs, active, onChange }) => (
  <div
    style={{
      display: 'flex',
      gap: 0,
      borderBottom: '1px solid var(--paper-shadow)',
    }}
  >
    {tabs.map((t) => (
      <button
        key={t.value}
        type="button"
        onClick={() => onChange(t.value)}
        className="paper-tab"
        data-active={active === t.value}
      >
        {t.label}
      </button>
    ))}
  </div>
)
