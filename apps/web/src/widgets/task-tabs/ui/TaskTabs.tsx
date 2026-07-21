import { useState, useEffect, type FC } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AgentCard } from '../../../entities/agent/index.js'
import { ArtifactCard } from '../../../entities/artifact/index.js'
import { AgentDrawer } from '../../../features/inspect-agent/index.js'
import { ArtifactPreview, useArtifactPreview } from '../../../features/view-artifact/index.js'
import { wsClient, restClient } from '../../../shared/api/index.js'
import type { Agent, Artifact, ServerToClient } from '@agent-team/protocol'

type Tab = 'agents' | 'files' | 'dashboard'

interface TaskTabsProps {
  taskId: string
}

export const TaskTabs: FC<TaskTabsProps> = ({ taskId }) => {
  const [activeTab, setActiveTab] = useState<Tab>('agents')
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null)
  const [agentDrawerOpen, setAgentDrawerOpen] = useState(false)
  const { selected: selectedArtifact, open: artifactOpen, openArtifact, close: closeArtifact } = useArtifactPreview()
  const queryClient = useQueryClient()

  const { data: agents = [] } = useQuery<Agent[]>({
    queryKey: ['agents', taskId],
    queryFn: () => restClient.get<Agent[]>(`/tasks/${taskId}/agents`),
  })

  const { data: artifacts = [] } = useQuery<Artifact[]>({
    queryKey: ['artifacts', taskId],
    queryFn: () => restClient.get<Artifact[]>(`/tasks/${taskId}/artifacts`),
  })

  // 监听 artifact-event WS 事件
  useEffect(() => {
    const remove = wsClient.addHandler((msg: ServerToClient) => {
      if (msg.type === 'artifact-event' && msg.taskId === taskId) {
        queryClient.setQueryData<Artifact[]>(['artifacts', taskId], (prev = []) => {
          if (prev.some((a) => a.id === msg.artifact.id)) return prev
          return [...prev, msg.artifact]
        })
      }
    })
    return remove
  }, [taskId, queryClient])

  const tabs: { id: Tab; label: string }[] = [
    { id: 'agents', label: `Agents (${agents.length})` },
    { id: 'files', label: `Files (${artifacts.length})` },
    { id: 'dashboard', label: 'Dashboard' },
  ]

  return (
    <>
      <div className="flex h-full flex-col">
        {/* Tab 头 */}
        <div className="flex border-b">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setActiveTab(t.id)}
              className={[
                'px-4 py-2 text-sm transition-colors',
                activeTab === t.id
                  ? 'border-b-2 border-primary font-medium'
                  : 'text-muted-foreground hover:text-foreground',
              ].join(' ')}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Tab 内容 */}
        <div className="flex-1 overflow-y-auto p-3">
          {activeTab === 'agents' && (
            <div className="flex flex-col gap-2">
              {agents.length === 0 && (
                <p className="text-sm text-muted-foreground">暂无 Agent</p>
              )}
              {agents.map((agent) => (
                <AgentCard
                  key={agent.id}
                  agent={agent}
                  onClick={() => {
                    setSelectedAgent(agent)
                    setAgentDrawerOpen(true)
                  }}
                />
              ))}
            </div>
          )}

          {activeTab === 'files' && (
            <div className="flex flex-col gap-2">
              {artifacts.length === 0 && (
                <p className="text-sm text-muted-foreground">暂无制品</p>
              )}
              {artifacts.map((artifact) => (
                <ArtifactCard
                  key={artifact.id}
                  artifact={artifact}
                  onClick={() => openArtifact(artifact)}
                />
              ))}
            </div>
          )}

          {activeTab === 'dashboard' && (
            <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
              Dashboard M1 简化 — 子任务进度在 M2 接入。
            </div>
          )}
        </div>
      </div>

      <AgentDrawer
        agent={selectedAgent}
        open={agentDrawerOpen}
        onClose={() => setAgentDrawerOpen(false)}
      />

      {selectedArtifact && (
        <ArtifactPreview
          artifact={selectedArtifact}
          open={artifactOpen}
          onClose={closeArtifact}
        />
      )}
    </>
  )
}
