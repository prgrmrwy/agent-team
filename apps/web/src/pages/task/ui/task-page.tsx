import { useEffect, useMemo, useRef, useState, type FC, type ReactNode } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { restClient, wsClient } from '../../../shared/api/index.js'
import { formatTokenCount } from '../../../shared/lib/token-usage.js'
import { isTerminalTaskState, type Task, type Seat, type Agent, type Factory, type TaskUsageResponse } from '@agent-team/protocol'
import type { ServerToClient } from '@agent-team/protocol'
import { TASK_STATE_LABEL } from '../../../entities/task/index.js'
import { attachSeatAgents, normalizeSeats } from '../../../entities/seat/index.js'
import { Chatroom } from '../../../widgets/chatroom-v2/index.js'
import { BootstrapProgress } from '../../../widgets/bootstrap-progress/index.js'
import { AgentAvatar } from '../../../shared/ui/agent-avatar/index.js'
import type { RoleName } from '../../../shared/icons/index.js'
import { useRightPanel } from '../../../shared/ui/right-panel.js'
import { FileViewer } from '../../../features/file-viewer/index.js'

interface TaskPageProps {
  taskId: string
}

/**
 * Task 详情(chatroom)— M3 T3 实现
 *
 * 上下结构:
 *   header(▸ profile + title + state pill + 控制按钮)
 *   state-pipeline(12 六边形)
 *   chatroom widget(channel tabs + 消息流 + seats bar + composer)
 *
 * profile 点 ▸ profile 展开到框架层 right panel,内容 TBD(T-next)。
 */
export const TaskPage: FC<TaskPageProps> = ({ taskId }) => {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { closeRightPanel, isRightPanelOpen, openRightPanel } = useRightPanel()
  const taskProfileKey = `task-profile:${taskId}`
  const isTaskProfileOpen = isRightPanelOpen(taskProfileKey)
  const { data: task } = useQuery<Task>({
    queryKey: ['task', taskId],
    queryFn: () => restClient.get<Task>(`/tasks/${taskId}`),
  })
  const { data: seats = [] } = useQuery<Seat[]>({
    queryKey: ['seats', taskId],
    queryFn: async () => normalizeSeats(await restClient.get<Seat[]>(`/tasks/${taskId}/seats`)),
  })
  const { data: agents = [] } = useQuery<Agent[]>({
    queryKey: ['agents', taskId],
    queryFn: () => restClient.get<Agent[]>(`/tasks/${taskId}/agents`),
  })
  const seatsWithAgents = useMemo(() => attachSeatAgents(seats, agents), [seats, agents])

  useEffect(() => {
    const remove = wsClient.addHandler((msg: ServerToClient) => {
      if (msg.type === 'phase-change' && msg.taskId === taskId) {
        queryClient.setQueryData<Task>(['task', taskId], (prev) =>
          prev ? ({ ...prev, state: msg.to } as Task) : prev,
        )
        queryClient.setQueryData<Task[]>(['tasks'], (prev = []) =>
          prev.map((t) => (t.id === taskId ? ({ ...t, state: msg.to } as Task) : t)),
        )
      }
      if (msg.type === 'seat-state' && msg.taskId === taskId) {
        queryClient.invalidateQueries({ queryKey: ['seats', taskId] })
        queryClient.invalidateQueries({ queryKey: ['agents', taskId] })
      }
    })
    return remove
  }, [queryClient, taskId])

  useEffect(() => {
    return () => closeRightPanel()
  }, [closeRightPanel, taskId])

  useEffect(() => {
    if (!task || !isTaskProfileOpen) return
    openRightPanel(
      taskProfileKey,
      <ChatroomProfilePanel task={task} taskId={taskId} onClose={closeRightPanel} />,
    )
  }, [closeRightPanel, isTaskProfileOpen, openRightPanel, task, taskId, taskProfileKey])

  /**
   * Phase 7.3:点击 done 进入 releasing(收尾中);后端把 task 转 releasing 后跑 planner 回顾,
   * 资源 release 完成后才推 phase-change → done。前端不再乐观置 done,也不立刻跳走 —
   * 用户需要看到收尾进度。task 真转 done 后(WS 推送)再跳回首页。
   */
  function markDone() {
    wsClient.send({ type: 'control', taskId, action: 'done' })
    queryClient.setQueryData<Task>(['task', taskId], (prev) =>
      prev ? ({ ...prev, state: 'releasing' } as Task) : prev,
    )
    queryClient.setQueryData<Task[]>(['tasks'], (prev = []) =>
      prev.map((t) => (t.id === taskId ? ({ ...t, state: 'releasing' } as Task) : t)),
    )
  }

  // 跟踪上一次 task.state — 只有真的发生 `releasing → done` 的迁移才回首页;
  // 进入一个本就 done 的 task / 直接首次 fetch 拿到 done 都不跳。
  const prevStateRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    const prev = prevStateRef.current
    const curr = task?.state
    prevStateRef.current = curr
    if (prev === 'releasing' && curr === 'done') {
      const timer = setTimeout(() => navigate({ to: '/' }), 800)
      return () => clearTimeout(timer)
    }
    return
  }, [navigate, task?.state])

  function toggleTaskProfile() {
    if (!task) return
    if (isTaskProfileOpen) {
      closeRightPanel()
      return
    }
    openRightPanel(
      taskProfileKey,
      <ChatroomProfilePanel task={task} taskId={taskId} onClose={closeRightPanel} />,
    )
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        position: 'relative',
      }}
    >
      {/* Header:标题 + 当前阶段 + 右上 profile/control */}
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '12px 20px',
          borderBottom: '1px solid var(--slate-edge)',
          background: 'var(--slate-bg)',
        }}
      >
        <h1
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 16,
            fontWeight: 600,
            letterSpacing: '0.04em',
            color: 'var(--ink-white)',
            margin: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {task?.title ?? '加载中…'}
        </h1>

        {task && <CurrentStatePill task={task} />}

        <div style={{ display: 'flex', gap: 4 }}>
          <ControlButton
            label={isTaskProfileOpen ? 'profile open' : 'profile'}
            onClick={toggleTaskProfile}
          />
          {task && !isTerminalTaskState(task.state) && (
            <ControlButton label={task?.state === 'releasing' ? 'nudge' : 'done'} onClick={markDone} accent />
          )}
        </div>
      </header>

      <BootstrapProgress taskId={taskId} />
      <AgentInitProgress seats={seatsWithAgents} agents={agents} />

      {/* Chatroom 主体 — flex:1 占剩余高度,内部 flex column 让 messages 滚动。
          key={taskId}:切任务时强制重挂载,清掉 partial 草稿 / streamStart 等 per-task 状态,
          避免上个任务的 streaming 气泡(如别 task 的 qa)泄漏到新任务视图。 */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <Chatroom key={taskId} taskId={taskId} />
      </div>
    </div>
  )
}

const CurrentStatePill: FC<{ task: Task }> = ({ task }) => (
  <span
    title={TASK_STATE_LABEL[task.state]}
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      background: 'rgba(91,200,221,0.12)',
      border: '1px solid var(--cyan-dim)',
      color: 'var(--cyan-bright)',
      padding: '3px 10px',
      fontSize: 10,
      fontWeight: 600,
      letterSpacing: '0.2em',
      textTransform: 'uppercase',
      borderRadius: 2,
      boxShadow: '0 0 8px var(--cyan-glow)',
      textShadow: '0 0 4px var(--cyan-glow)',
      fontFamily: 'var(--font-chrome)',
      whiteSpace: 'nowrap',
    }}
  >
    <span
      aria-hidden="true"
      className={task.state === 'done' || task.state === 'aborted' ? undefined : 'ab-pulse'}
      style={{
        width: 6,
        height: 6,
        borderRadius: '50%',
        background: task.state === 'aborted' ? 'var(--malice)' : 'var(--cyan)',
        boxShadow: `0 0 4px ${task.state === 'aborted' ? 'var(--malice)' : 'var(--cyan)'}`,
      }}
    />
    {task.state.replace("'", '')}
  </span>
)

const AgentInitProgress: FC<{ seats: Seat[]; agents: Agent[] }> = ({ seats, agents }) => {
  const initializing = useMemo(
    () =>
      seats.filter((seat) => {
        if (seat.status === 'init' || seat.status === 'switching') return true
        if (seat.status !== 'vacant' && seat.currentAgentId && !agents.some((a) => a.id === seat.currentAgentId)) {
          return true
        }
        return false
      }),
    [agents, seats],
  )

  if (initializing.length === 0) return <div style={{ display: 'none' }} />

  // 样式严格对齐 BootstrapProgress:同容器(padding 8px 20px / gap 6 / 同 borderBottom + gradient),
  // 每个 agent 一行 = [role 色 pulse 点] [eyebrow 工厂名] [role · factory] [initializing…],
  // 与 "● BOOTSTRAP  worktree·sw/lean  preparing…" 行内 dot-first 结构一致。
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '8px 20px',
        borderBottom: '1px solid var(--slate-edge)',
        background: 'linear-gradient(180deg, rgba(91,200,221,0.06), rgba(8,20,26,0.55))',
      }}
    >
      {initializing.map((seat) => {
        const role = factoryToRoleName(seat.factory)
        return (
          <div
            key={seat.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              color: 'var(--ink-soft)',
              fontFamily: 'var(--font-chrome)',
              fontSize: 11,
            }}
          >
            <span
              aria-hidden="true"
              className="ab-pulse"
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: `var(--${role})`,
                boxShadow: `0 0 6px var(--${role})`,
                flexShrink: 0,
              }}
            />
            <span className="ab-eyebrow" style={{ color: `var(--${role})`, whiteSpace: 'nowrap' }}>
              {seat.factory}
            </span>
            <span style={{ color: 'var(--ink-dim)', whiteSpace: 'nowrap' }}>{seat.role}</span>
            <span style={{ flex: 1, minWidth: 0, color: 'var(--ink-dim)' }}>initializing…</span>
          </div>
        )
      })}
    </div>
  )
}

function factoryToRoleName(factory: string): RoleName {
  if (factory === 'pm-ux') return 'pmux'
  if (['planner', 'engineer', 'qa', 'anti', 'ci'].includes(factory)) return factory as RoleName
  return 'planner'
}

type ChatroomTab = 'meta' | 'seats' | 'usage' | 'workspace'

/**
 * Chatroom (= task) profile panel — task 元数据 + seats/agents 实时 + workspace。
 * 大块信息分 tab 切换:META / SEATS / USAGE / WORKSPACE(不堆叠,聚焦阅读)。
 */
const ChatroomProfilePanel: FC<{ task: Task; taskId: string; onClose: () => void }> = ({
  task,
  taskId,
  onClose,
}) => {
  const [activeTab, setActiveTab] = useState<ChatroomTab>('meta')
  const { resizeRightPanel } = useRightPanel()
  const { data: seats = [] } = useQuery<Seat[]>({
    queryKey: ['seats', taskId],
    queryFn: async () => normalizeSeats(await restClient.get<Seat[]>(`/tasks/${taskId}/seats`)),
  })
  const { data: agents = [] } = useQuery<Agent[]>({
    queryKey: ['agents', taskId],
    queryFn: () => restClient.get<Agent[]>(`/tasks/${taskId}/agents`),
  })
  const seatsWithAgents = useMemo(() => attachSeatAgents(seats, agents), [seats, agents])
  const { data: factories = [] } = useQuery<Factory[]>({
    queryKey: ['factories'],
    queryFn: () => restClient.get<Factory[]>('/factories'),
  })
  const { data: usage } = useQuery<TaskUsageResponse>({
    queryKey: ['task-usage', taskId],
    queryFn: () => restClient.get<TaskUsageResponse>(`/tasks/${taskId}/usage`),
  })

  const agentBySeat: Record<string, Agent | undefined> = Object.fromEntries(
    seatsWithAgents.map((s) => [s.id, agents.find((a) => a.id === s.currentAgentId)]),
  )

  useEffect(() => {
    resizeRightPanel(activeTab === 'workspace' ? '800px' : undefined)
  }, [activeTab, resizeRightPanel])

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
          task profile
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

      {/* TabBar 跟 header 一起置顶,不参与滚动 */}
      <div style={{ padding: '0 20px', flexShrink: 0 }}>
        <TabBar
          tabs={[
            { value: 'meta', label: 'META' },
            { value: 'seats', label: `SEATS (${seats.length})` },
            { value: 'usage', label: 'USAGE' },
            { value: 'workspace', label: 'WORKSPACE' },
          ]}
          active={activeTab}
          onChange={(v) => setActiveTab(v as ChatroomTab)}
        />
      </div>

      <div
        className="paper-body"
        style={{
          padding: activeTab === 'workspace' ? 0 : '14px 20px 18px',
          overflowY: activeTab === 'workspace' ? 'hidden' : 'auto',
          flex: 1,
          minHeight: 0,
        }}
      >
          <div style={activeTab === 'workspace' ? { height: '100%', minHeight: 0 } : undefined}>
            {activeTab === 'meta' && (
              <dl
                style={{
                  display: 'grid',
                  gridTemplateColumns: '76px 1fr',
                  gap: '7px 12px',
                  margin: 0,
                  fontSize: 14,
                }}
              >
                <dt className="ab-eyebrow">id</dt>
                <dd className="ab-tabular" style={{ margin: 0, wordBreak: 'break-all' }}>
                  {task.id}
                </dd>
                <dt className="ab-eyebrow">project</dt>
                <dd style={{ margin: 0 }}>{task.projectId}</dd>
                <dt className="ab-eyebrow">state</dt>
                <dd style={{ margin: 0 }}>
                  {task.state} · {TASK_STATE_LABEL[task.state]}
                </dd>
                <dt className="ab-eyebrow">created</dt>
                <dd className="ab-tabular" style={{ margin: 0 }}>
                  {task.createdAt}
                </dd>
                <dt className="ab-eyebrow">desc</dt>
                <dd style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{task.description}</dd>
              </dl>
            )}

            {activeTab === 'seats' && (
              <>
                {seatsWithAgents.length === 0 && (
                  <span style={{ fontSize: 14, color: 'var(--ink-brown-d)', fontStyle: 'italic' }}>
                    (planner 还没招过 seat)
                  </span>
                )}
                {seatsWithAgents.map((s) => {
                  const a = agentBySeat[s.id]
                  const role = factoryToRoleName(s.factory)
                  const factory = factories.find((f) => f.name === s.factory)
                  return (
                    <div
                      key={s.id}
                      style={{
                        display: 'flex',
                        gap: 10,
                        padding: '9px 0',
                        alignItems: 'center',
                        borderBottom: '1px dashed var(--paper-shadow)',
                      }}
                    >
                      <AgentAvatar
                        agent={a ?? undefined}
                        seat={s}
                        role={role}
                        size={28}
                        displayName={a?.displayName ?? s.role}
                      />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 16, color: 'var(--ink-brown)' }}>
                          {a?.displayName ?? s.role}
                          <span
                            style={{ marginLeft: 6, fontSize: 12, color: 'var(--ink-brown-d)' }}
                          >
                            ({s.factory}
                            {factory && ` v${factory.version}`})
                          </span>
                        </div>
                        <div
                          className="ab-tabular"
                          style={{ fontSize: 11, color: 'var(--ink-brown-d)' }}
                        >
                          {s.role} · {s.status}
                          {a && ` · spawned ${shortTime(a.spawnedAt)}`}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </>
            )}

            {activeTab === 'usage' && (
              <TokenUsagePanel
                runtimeTotal={usage?.totals.runtime.totalTokens ?? 0}
                chatroomReadTotal={usage?.totals.chatroomRead.totalTokens ?? 0}
                chatroomCorpusTotal={usage?.totals.chatroomCorpus.totalTokens ?? 0}
                agents={usage?.agents ?? []}
              />
            )}

            {activeTab === 'workspace' && (
              <WorkspaceBrowser taskId={taskId} />
            )}
          </div>

          {activeTab !== 'workspace' && (
            <>
              <hr className="paper-rule" style={{ margin: '18px 0 12px' }} />
              <p
                style={{
                  margin: 0,
                  fontSize: 13,
                  color: 'var(--ink-brown-d)',
                  fontStyle: 'italic',
                }}
              >
                dashboard · artifacts · 复盘文档 等 tab 留 T-next
              </p>
            </>
          )}
      </div>
    </div>
  )
}

interface WorkspaceEntry {
  name: string
  type: 'dir' | 'file'
}

const WorkspaceBrowser: FC<{ taskId: string }> = ({ taskId }) => {
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '260px minmax(0, 1fr)',
        height: '100%',
        minHeight: 0,
      }}
    >
      <div
        style={{
          minWidth: 0,
          overflow: 'auto',
          padding: '14px 12px 18px 20px',
          borderRight: '1px solid var(--paper-shadow)',
        }}
      >
        <WorkspaceTree taskId={taskId} selectedPath={selectedPath} onOpenFile={setSelectedPath} />
      </div>
      <div style={{ minWidth: 0, minHeight: 0, height: '100%', overflow: 'hidden' }}>
        {selectedPath ? (
          <FileViewer taskId={taskId} path={selectedPath} embedded />
        ) : (
          <div
            style={{
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--ink-brown-d)',
              fontSize: 13,
              fontStyle: 'italic',
            }}
          >
            选择左侧文件查看内容
          </div>
        )}
      </div>
    </div>
  )
}

const WorkspaceTree: FC<{
  taskId: string
  selectedPath: string | null
  onOpenFile: (path: string) => void
}> = ({
  taskId,
  selectedPath,
  onOpenFile,
}) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
    <div className="ab-eyebrow" style={{ marginBottom: 8, color: 'var(--paper-deep)' }}>
      chatroom workspace
    </div>
    <WorkspaceDirectory
      taskId={taskId}
      path=""
      depth={0}
      selectedPath={selectedPath}
      onOpenFile={onOpenFile}
      initialOpen
    />
  </div>
)

const WorkspaceDirectory: FC<{
  taskId: string
  path: string
  depth: number
  selectedPath: string | null
  onOpenFile: (path: string) => void
  initialOpen?: boolean
}> = ({ taskId, path: dirPath, depth, selectedPath, onOpenFile, initialOpen }) => {
  const [open, setOpen] = useState(Boolean(initialOpen))
  const query = useQuery<{ entries: WorkspaceEntry[] }>({
    queryKey: ['workspace-ls', taskId, dirPath],
    queryFn: () =>
      restClient.get<{ entries: WorkspaceEntry[] }>(
        `/tasks/${taskId}/workspace/ls?path=${encodeURIComponent(dirPath)}`,
      ),
    enabled: open,
  })
  const label = dirPath ? dirPath.split('/').filter(Boolean).at(-1) ?? dirPath : '.'
  return (
    <div>
      {dirPath && (
        <TreeRow
          depth={depth}
          label={label}
          marker={query.isLoading ? '…' : open ? '▾' : '▸'}
          onClick={() => setOpen((v) => !v)}
        />
      )}
      {open && (
        <div>
          {query.isLoading && !query.data && (
            <TreeMuted depth={dirPath ? depth + 1 : depth}>loading…</TreeMuted>
          )}
          {query.isError && (
            <TreeMuted depth={dirPath ? depth + 1 : depth}>无法读取目录</TreeMuted>
          )}
          {query.data?.entries.length === 0 && (
            <TreeMuted depth={dirPath ? depth + 1 : depth}>empty</TreeMuted>
          )}
          {query.data?.entries.map((entry) => {
            const childPath = dirPath ? `${dirPath}/${entry.name}` : entry.name
            if (entry.type === 'dir') {
              return (
                <WorkspaceDirectory
                  key={childPath}
                  taskId={taskId}
                  path={childPath}
                  depth={dirPath ? depth + 1 : depth}
                  selectedPath={selectedPath}
                  onOpenFile={onOpenFile}
                />
              )
            }
            return (
              <TreeRow
                key={childPath}
                depth={dirPath ? depth + 1 : depth}
                label={entry.name}
                marker="·"
                selected={selectedPath === childPath}
                onClick={() => onOpenFile(childPath)}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

const TreeRow: FC<{
  depth: number
  marker: string
  label: string
  onClick: () => void
  selected?: boolean
}> = ({
  depth,
  marker,
  label,
  onClick,
  selected = false,
}) => (
  <button
    type="button"
    onClick={onClick}
    style={{
      width: '100%',
      display: 'grid',
      gridTemplateColumns: '18px 1fr',
      gap: 4,
      alignItems: 'center',
      padding: '4px 0',
      paddingLeft: depth * 14,
      background: selected ? 'rgba(107, 79, 31, 0.14)' : 'transparent',
      border: selected ? '1px solid var(--paper-shadow)' : '1px solid transparent',
      color: selected ? 'var(--paper-deep)' : 'var(--ink-brown)',
      cursor: 'pointer',
      fontFamily: 'var(--font-chrome)',
      fontSize: 12,
      textAlign: 'left',
    }}
  >
    <span style={{ color: 'var(--paper-deep)' }}>{marker}</span>
    <span className="ab-tabular" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
      {label}
    </span>
  </button>
)

const TreeMuted: FC<{ depth: number; children: ReactNode }> = ({ depth, children }) => (
  <div
    style={{
      padding: '4px 0',
      paddingLeft: depth * 14 + 22,
      color: 'var(--ink-brown-d)',
      fontSize: 12,
      fontStyle: 'italic',
    }}
  >
    {children}
  </div>
)

/** 通用 Tab bar — 用于 right panel 大块信息切换 */
const TabBar: FC<{
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

const TokenUsagePanel: FC<{
  runtimeTotal: number
  chatroomReadTotal: number
  chatroomCorpusTotal: number
  agents: Array<{ id: string; label: string; totalTokens: number }>
}> = ({ runtimeTotal, chatroomReadTotal, chatroomCorpusTotal, agents }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
    <dl
      style={{
        display: 'grid',
        gridTemplateColumns: '116px 1fr',
        gap: '7px 12px',
        margin: 0,
        fontSize: 14,
      }}
    >
      <dt className="ab-eyebrow">runtime total</dt>
      <dd className="ab-tabular" style={{ margin: 0 }}>
        {formatTokenCount(runtimeTotal)}
      </dd>
      <dt className="ab-eyebrow">chatroom read</dt>
      <dd className="ab-tabular" style={{ margin: 0 }}>
        {formatTokenCount(chatroomReadTotal)}
      </dd>
      <dt className="ab-eyebrow">chatroom corpus</dt>
      <dd className="ab-tabular" style={{ margin: 0 }}>
        {formatTokenCount(chatroomCorpusTotal)}
      </dd>
    </dl>

    <div style={{ borderTop: '1px solid var(--paper-shadow)', paddingTop: 10 }}>
      <div className="ab-eyebrow" style={{ marginBottom: 8 }}>
        agents
      </div>
      {agents.length === 0 ? (
        <span style={{ fontSize: 14, color: 'var(--ink-brown-d)', fontStyle: 'italic' }}>
          (no agent usage yet)
        </span>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {agents.map((agent) => (
            <div
              key={agent.id}
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr auto',
                gap: 10,
                alignItems: 'center',
                padding: '7px 0',
                borderBottom: '1px dashed var(--paper-shadow)',
              }}
            >
              <span
                className="ab-tabular"
                style={{
                  color: 'var(--ink-brown)',
                  fontSize: 12,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {agent.label}
              </span>
              <span className="ab-tabular" style={{ color: 'var(--paper-deep)', fontSize: 12 }}>
                {formatTokenCount(agent.totalTokens)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  </div>
)

const Section: FC<{ title: string; children: ReactNode }> = ({ title, children }) => (
  <section style={{ marginBottom: 14 }}>
    <h3 className="ab-eyebrow" style={{ color: 'var(--cyan)', marginBottom: 6 }}>
      {title}
    </h3>
    <div>{children}</div>
  </section>
)

function shortTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-')
}

const ControlButton: FC<{
  label: string
  onClick: () => void
  accent?: boolean
  danger?: boolean
}> = ({ label, onClick, accent, danger }) => (
  <button
    type="button"
    onClick={onClick}
    style={{
      background: accent
        ? 'rgba(91,200,221,0.15)'
        : danger
          ? 'rgba(184,58,90,0.12)'
          : 'transparent',
      border: `1px solid ${accent ? 'var(--cyan)' : danger ? 'var(--malice)' : 'var(--slate-edge)'}`,
      color: accent ? 'var(--cyan-bright)' : danger ? 'var(--malice)' : 'var(--ink-soft)',
      padding: '4px 10px',
      fontSize: 10,
      fontWeight: 600,
      letterSpacing: '0.18em',
      textTransform: 'uppercase',
      borderRadius: 2,
      cursor: 'pointer',
      fontFamily: 'var(--font-chrome)',
    }}
  >
    {label}
  </button>
)
