import { useState, type FC } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { attachSeatAgents, normalizeSeats, SeatChip } from '../../../entities/seat/index.js'
import { AgentDrawer } from '../../../features/inspect-agent/index.js'
import { RecruitButton } from '../../../features/recruit-seat/index.js'
import { wsClient, restClient } from '../../../shared/api/index.js'
import type { Seat, Agent, ServerToClient } from '@agent-team/protocol'

interface SeatBarProps {
  taskId: string
}

export const SeatBar: FC<SeatBarProps> = ({ taskId }) => {
  const queryClient = useQueryClient()
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)

  const { data: seats = [] } = useQuery<Seat[]>({
    queryKey: ['seats', taskId],
    queryFn: async () => normalizeSeats(await restClient.get<Seat[]>(`/tasks/${taskId}/seats`)),
  })

  const { data: agents = [] } = useQuery<Agent[]>({
    queryKey: ['agents', taskId],
    queryFn: () => restClient.get<Agent[]>(`/tasks/${taskId}/agents`),
  })

  // 监听 seat-state WS 事件，更新 seat 状态
  useEffect(() => {
    const remove = wsClient.addHandler((msg: ServerToClient) => {
      if (msg.type === 'seat-state' && msg.taskId === taskId) {
        // derive-presence:seat-state 携带 presence;映射回 SeatStatus(spawning→init)
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
      }
    })
    return remove
  }, [taskId, queryClient])

  /** seatId → 当前占据该岗位的 agent */
  function agentForSeat(seat: Seat): Agent | undefined {
    return agents.find((a) => a.seatId === seat.id)
  }

  function handleSeatClick(seat: Seat) {
    const agent = agentForSeat(seat)
    if (agent) {
      setSelectedAgent(agent)
      setDrawerOpen(true)
    }
  }

  return (
    <>
      <div className="flex items-center gap-2 overflow-x-auto px-3 py-2 border-b bg-background">
        {seats.length === 0 && (
          <span className="text-xs text-muted-foreground">暂无岗位</span>
        )}
        {attachSeatAgents(seats, agents).map((seat) => {
          const agent = agentForSeat(seat)
          return (
            <div key={seat.id} className="flex items-center gap-1">
              <SeatChip
                seat={seat}
                displayName={agent?.displayName}
                onClick={() => handleSeatClick(seat)}
              />
              {seat.status === 'vacant' && (
                <RecruitButton seatId={seat.id} taskId={taskId} />
              )}
            </div>
          )
        })}
      </div>

      <AgentDrawer
        agent={selectedAgent}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
      />
    </>
  )
}
