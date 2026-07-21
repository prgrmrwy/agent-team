import type { FC, MouseEvent, KeyboardEvent } from 'react'
import { useState, useMemo, useRef, useEffect } from 'react'
import { Link, useNavigate, useRouterState } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { restClient, wsClient } from '../../../shared/api/index.js'
import { SheikahEye } from '../../../shared/ui/sheikah-eye.js'
import { SettingsDialog } from '../../../features/settings-panel/index.js'
import { isTerminalTaskState, type Task, type Project, type Factory } from '@agent-team/protocol'
import {
  findFirstVisibleTask,
  matchesTaskFilter,
  type TaskFilter,
} from './sidebar-task-filter.js'

/**
 * Sidebar — design-handoff §5.9 / acceptance.md AC-3..AC-9
 *
 * 从上到下:
 *   [+ 新建](全宽 cyan 按钮,主操作)
 *   TASKS eyebrow
 *     ▾ DEFAULT PROJECT  (可折叠 group label)
 *       ● Task A     S6   (role 圆点 + name + state code,active 态高亮)
 *       ● Task B     S2
 *     ▸ OTHER PROJECT   (折叠态)
 *   FACTORIES eyebrow
 *     planner v3 / engineer v1 / qa v2 / ci v1
 */
export const Sidebar: FC = () => {
  const [taskFilter, setTaskFilter] = useState<TaskFilter>('active')
  const navigate = useNavigate()
  const routerState = useRouterState()
  const currentTaskId = useMemo(() => {
    const m = routerState.location.pathname.match(/^\/tasks\/([^/]+)/)
    return m ? m[1] : null
  }, [routerState.location.pathname])
  const { data: projects = [] } = useQuery<Project[]>({
    queryKey: ['projects'],
    queryFn: () => restClient.get<Project[]>('/projects'),
  })
  const { data: factories = [] } = useQuery<Factory[]>({
    queryKey: ['factories'],
    queryFn: () => restClient.get<Factory[]>('/factories'),
  })
  const { data: tasks = [] } = useQuery<Task[]>({
    queryKey: ['tasks'],
    queryFn: () => restClient.get<Task[]>('/tasks'),
  })

  // 路由跳到一个具体 task → 自动切到包含它的 filter(每次 task 切换都跟随;
  // 用户在同一 task 页内手动改 filter 不会被覆盖,只在 currentTaskId 变时触发)
  useEffect(() => {
    if (!currentTaskId) return
    const t = tasks.find((x) => x.id === currentTaskId)
    if (!t) return
    if (matchesTaskFilter(t, taskFilter)) return
    // 选最具体的 filter:done > releasing > active
    const next: TaskFilter = isTerminalTaskState(t.state) ? 'done' : t.state === 'releasing' ? 'releasing' : 'active'
    setTaskFilter(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTaskId, tasks])

  const projectsResolved = useMemo<Project[]>(
    () =>
      projects.length > 0
        ? projects
        : [{ id: 'default', name: 'Default 项目', createdAt: new Date().toISOString() }],
    [projects],
  )

  const filteredTasks = useMemo(
    () => tasks.filter((task) => matchesTaskFilter(task, taskFilter)),
    [tasks, taskFilter],
  )
  const taskCounts = useMemo(
    () => ({
      active: tasks.filter((task) => matchesTaskFilter(task, 'active')).length,
      releasing: tasks.filter((task) => matchesTaskFilter(task, 'releasing')).length,
      done: tasks.filter((task) => matchesTaskFilter(task, 'done')).length,
      all: tasks.length,
    }),
    [tasks],
  )
  function handleTaskFilterChange(next: TaskFilter) {
    setTaskFilter(next)
    const firstTask = findFirstVisibleTask(tasks, projectsResolved, next)
    if (!firstTask) {
      void navigate({ to: '/' })
    } else if (firstTask.id !== currentTaskId) {
      void navigate({ to: '/tasks/$taskId', params: { taskId: firstTask.id } })
    }
  }

  // Factory 行高 ~22(padding 8 + content 14);8 个 + gap 6 ≈ 220px。
  const FACTORIES_MAX_H = 220
  const [settingsOpen, setSettingsOpen] = useState(false)
  return (
    <aside
      style={{
        background: 'linear-gradient(180deg, var(--slate-surface), var(--slate-bg))',
        borderRight: '1px solid var(--slate-edge)',
        boxShadow: 'inset -1px 0 0 var(--cyan-dim)',
        padding: '14px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        height: '100%',
        minHeight: 0,
        overflow: 'hidden',
        position: 'relative',
        zIndex: 5,
      }}
    >
      <SidebarBrand />

      <hr className="ab-divider" />

      <NewTaskButton />

      <hr className="ab-divider" />

      {/* Tasks 占剩余空间 */}
      <section
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          flex: 1,
          minHeight: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexShrink: 0 }}>
          <span className="ab-eyebrow" style={{ color: 'var(--cyan)' }}>
            Tasks
          </span>
          <TaskFilterMenu value={taskFilter} counts={taskCounts} onChange={handleTaskFilterChange} />
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {projectsResolved.map((p, i) => (
            <ProjectGroup
              key={p.id}
              project={p}
              tasks={filteredTasks.filter((t) => (t.projectId ?? 'default') === p.id)}
              filter={taskFilter}
              defaultOpen={i === 0}
            />
          ))}
        </div>
      </section>

      <hr className="ab-divider" style={{ flexShrink: 0 }} />

      {/* Factories 最多 8 行,内部滚动 */}
      <section
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          flexShrink: 0,
          maxHeight: FACTORIES_MAX_H,
        }}
      >
        <span className="ab-eyebrow" style={{ flexShrink: 0 }}>Factories</span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, overflowY: 'auto', minHeight: 0 }}>
          {factories.map((f) => (
            <Link
              key={f.name}
              to="/factories/$name"
              params={{ name: f.name }}
              activeProps={{ style: { color: 'var(--ink-white)' } }}
              style={{
                display: 'flex',
                alignItems: 'baseline',
                gap: 6,
                padding: '4px 6px',
                fontSize: 11,
                color: 'var(--ink-soft)',
                textDecoration: 'none',
                borderLeft: '2px solid transparent',
                flexShrink: 0,
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: `var(--${f.name})`,
                  boxShadow: `0 0 4px var(--${f.name})`,
                  display: 'inline-block',
                  flexShrink: 0,
                }}
              />
              <span style={{ flex: 1, textTransform: 'lowercase' }}>{f.name}</span>
              <span
                className="ab-tabular"
                style={{
                  fontSize: 9,
                  color: 'var(--ink-dim)',
                  letterSpacing: '0.1em',
                }}
              >
                v{f.version}
              </span>
            </Link>
          ))}
          {factories.length === 0 && (
            <span style={{ fontSize: 10, color: 'var(--ink-dimmer)', padding: '4px 6px' }}>
              (无工厂)
            </span>
          )}
        </div>
      </section>

      <SettingsRow onOpen={() => setSettingsOpen(true)} />
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </aside>
  )
}

/** 顶部 brand:SheikahEye + AGENT TEAM + 1s tick 时钟,单行 HUD */
const SidebarBrand: FC = () => {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(id)
  }, [])
  const timeStr = now.toTimeString().slice(0, 8)
  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        flexShrink: 0,
      }}
    >
      <SheikahEye size={18} />
      <span
        className="ab-hud"
        style={{
          color: 'var(--ink-white)',
          fontSize: 12,
          letterSpacing: '0.16em',
          flex: 1,
        }}
      >
        AGENT TEAM
      </span>
      <span
        className="ab-tabular"
        style={{
          fontSize: 10,
          color: 'var(--ink-dim)',
          letterSpacing: '0.08em',
        }}
      >
        {timeStr}
      </span>
    </header>
  )
}

/** 底部 settings 触发条:分隔线 + 右对齐 ⚙ */
const SettingsRow: FC<{ onOpen: () => void }> = ({ onOpen }) => (
  <div style={{ flexShrink: 0 }}>
    <hr className="ab-divider" style={{ marginBottom: 6 }} />
    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
      <button
        type="button"
        onClick={onOpen}
        aria-label="Settings"
        title="Settings"
        style={{
          width: 24,
          height: 24,
          background: 'transparent',
          border: '1px solid var(--slate-edge)',
          color: 'var(--ink-soft)',
          borderRadius: 2,
          cursor: 'pointer',
          fontSize: 14,
          lineHeight: 1,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          transition: 'color 120ms, border-color 120ms, box-shadow 120ms',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.color = 'var(--cyan-bright)'
          e.currentTarget.style.borderColor = 'var(--cyan)'
          e.currentTarget.style.boxShadow = '0 0 8px var(--cyan-glow)'
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = 'var(--ink-soft)'
          e.currentTarget.style.borderColor = 'var(--slate-edge)'
          e.currentTarget.style.boxShadow = 'none'
        }}
      >
        ⚙
      </button>
    </div>
  </div>
)

const NewTaskButton: FC = () => (
  <Link
    to="/"
    style={{
      display: 'block',
      width: '100%',
      padding: '6px 12px',
      textAlign: 'center',
      background: 'linear-gradient(180deg, rgba(91,200,221,0.12), rgba(91,200,221,0.04))',
      border: '1px solid var(--cyan-dim)',
      color: 'var(--cyan)',
      fontSize: 11,
      fontWeight: 600,
      textTransform: 'uppercase',
      letterSpacing: '0.2em',
      fontFamily: 'var(--font-chrome)',
      textDecoration: 'none',
      borderRadius: 2,
      transition: 'color 120ms, border-color 120ms, box-shadow 120ms',
    }}
    onMouseEnter={(e) => {
      e.currentTarget.style.color = 'var(--cyan-bright)'
      e.currentTarget.style.borderColor = 'var(--cyan)'
      e.currentTarget.style.boxShadow =
        '0 0 16px var(--cyan-glow), inset 0 0 12px rgba(91,200,221,0.08)'
    }}
    onMouseLeave={(e) => {
      e.currentTarget.style.color = 'var(--cyan)'
      e.currentTarget.style.borderColor = 'var(--cyan-dim)'
      e.currentTarget.style.boxShadow = 'none'
    }}
  >
    + 新建
  </Link>
)

const TASK_FILTER_OPTIONS: TaskFilter[] = ['active', 'releasing', 'done', 'all']
const TASK_FILTER_LABELS: Record<TaskFilter, string> = {
  active: 'active',
  releasing: 'releasing',
  done: 'done',
  all: 'all',
}

/**
 * Filter icon + hover/click dropdown — releasing 名字太长不适合并排 tabs。
 * hover 或 click 弹小面板,选中带 ✓。
 */
const TaskFilterMenu: FC<{
  value: TaskFilter
  counts: Record<TaskFilter, number>
  onChange: (value: TaskFilter) => void
}> = ({ value, counts, onChange }) => {
  const [open, setOpen] = useState(false)
  const closeTimer = useRef<number | null>(null)
  function scheduleClose() {
    if (closeTimer.current) window.clearTimeout(closeTimer.current)
    closeTimer.current = window.setTimeout(() => setOpen(false), 180)
  }
  function cancelClose() {
    if (closeTimer.current) {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }
  return (
    <div
      style={{ position: 'relative' }}
      onMouseEnter={() => {
        cancelClose()
        setOpen(true)
      }}
      onMouseLeave={scheduleClose}
    >
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        title={`filter:${value} (${counts[value]})`}
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 4,
          height: 22,
          minWidth: 36,
          padding: '0 6px',
          border: '1px solid var(--slate-edge)',
          background: open ? 'rgba(91,200,221,0.13)' : 'rgba(5, 12, 20, 0.42)',
          color: open ? 'var(--cyan-bright)' : 'var(--ink-dim)',
          cursor: 'pointer',
          fontFamily: 'var(--font-chrome)',
          fontSize: 10,
          borderRadius: 2,
        }}
      >
        {/* funnel icon */}
        <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M2 3 L14 3 L10 9 L10 13 L6 13 L6 9 Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
        </svg>
        <span className="ab-tabular" style={{ fontSize: 9, color: 'var(--ink-dimmer)' }}>
          {counts[value]}
        </span>
      </button>
      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            right: 0,
            zIndex: 30,
            minWidth: 150,
            background: 'var(--slate-elev)',
            border: '1px solid var(--cyan-dim)',
            borderRadius: 2,
            boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
            padding: 2,
          }}
        >
          {TASK_FILTER_OPTIONS.map((option) => {
            const selected = value === option
            return (
              <button
                key={option}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                onClick={() => {
                  onChange(option)
                  setOpen(false)
                }}
                style={{
                  display: 'flex',
                  width: '100%',
                  alignItems: 'center',
                  gap: 6,
                  padding: '5px 8px',
                  background: selected ? 'rgba(91,200,221,0.13)' : 'transparent',
                  border: 'none',
                  color: selected ? 'var(--cyan-bright)' : 'var(--ink-soft)',
                  cursor: 'pointer',
                  fontFamily: 'var(--font-chrome)',
                  fontSize: 11,
                  textAlign: 'left',
                  borderRadius: 1,
                }}
                onMouseEnter={(e) => {
                  if (!selected) e.currentTarget.style.background = 'rgba(91,200,221,0.08)'
                }}
                onMouseLeave={(e) => {
                  if (!selected) e.currentTarget.style.background = 'transparent'
                }}
              >
                <span style={{ width: 10, fontSize: 9 }}>{selected ? '✓' : ''}</span>
                <span style={{ flex: 1 }}>{TASK_FILTER_LABELS[option]}</span>
                <span
                  className="ab-tabular"
                  style={{ fontSize: 9, color: 'var(--ink-dim)' }}
                >
                  {counts[option]}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

const ProjectGroup: FC<{
  project: Project
  tasks: Task[]
  filter: TaskFilter
  defaultOpen: boolean
}> = ({
  project,
  tasks,
  filter,
  defaultOpen,
}) => {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          borderBottom: '1px dashed var(--slate-edge)',
          padding: '4px 2px',
          gap: 6,
        }}
      >
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          style={{
            background: 'transparent',
            border: 'none',
            padding: 0,
            textAlign: 'left',
            color: 'var(--ink-dim)',
            fontSize: 9,
            textTransform: 'uppercase',
            letterSpacing: '0.3em',
            cursor: 'pointer',
            fontFamily: 'var(--font-chrome)',
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            flex: 1,
            minWidth: 0,
          }}
          aria-expanded={open}
        >
          <span style={{ display: 'inline-block', width: 8 }}>{open ? '▾' : '▸'}</span>
          <span
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {project.name || project.id}
          </span>
          <span
            className="ab-tabular"
            style={{
              marginLeft: 'auto',
              fontSize: 9,
              color: 'var(--ink-dimmer)',
              letterSpacing: '0.05em',
            }}
          >
            {tasks.length}
          </span>
        </button>
        <Link
          to="/"
          search={{ project: project.id }}
          aria-label={`在 ${project.name || project.id} 下新建任务`}
          title={`在 ${project.name || project.id} 下新建任务`}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 18,
            height: 18,
            border: '1px solid var(--cyan-dim)',
            color: 'var(--cyan)',
            fontSize: 12,
            lineHeight: 1,
            fontFamily: 'var(--font-chrome)',
            textDecoration: 'none',
            cursor: 'pointer',
            flexShrink: 0,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = 'var(--cyan-bright)'
            e.currentTarget.style.borderColor = 'var(--cyan)'
            e.currentTarget.style.boxShadow = '0 0 6px var(--cyan-glow)'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = 'var(--cyan)'
            e.currentTarget.style.borderColor = 'var(--cyan-dim)'
            e.currentTarget.style.boxShadow = 'none'
          }}
        >
          +
        </Link>
      </div>

      {open && (
        <ul
          style={{
            listStyle: 'none',
            padding: 0,
            margin: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}
        >
          {tasks.length === 0 && (
            <li
              style={{
                fontSize: 10,
                color: 'var(--ink-dimmer)',
                padding: '6px 8px',
                fontStyle: 'italic',
              }}
            >
              {emptyTaskCopy(filter)}
            </li>
          )}
          {tasks.map((t) => (
            <TaskItem key={t.id} task={t} />
          ))}
        </ul>
      )}
    </div>
  )
}

const TaskItem: FC<{ task: Task }> = ({ task }) => {
  const routerState = useRouterState()
  const navigate = useNavigate()
  const active = routerState.location.pathname === `/tasks/${task.id}`
  const role = inferSpeakingRole(task)
  const [hover, setHover] = useState(false)
  const queryClient = useQueryClient()
  const isDone = isTerminalTaskState(task.state)
  // 当本 item 变 active(用户从别处跳进来) → 滚进视窗;不破坏列表自然顺序
  const liRef = useRef<HTMLLIElement>(null)
  useEffect(() => {
    if (active) liRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [active])
  // releasing(收尾中)不再点 done,但行项 UI 仍正常(无 line-through / opacity)
  const showDoneBtn = hover && !isDone && task.state !== 'releasing'

  // hover 显示 done 按钮(已 done / releasing 任务不显示)。点击乐观置 releasing
  // (符合 task-bootstrap-lifecycle phase 5:done → releasing → planner 出 retro
  // + archive-plan → resource 终态 → 真 done。task-page 的 markDone 同此语义)。
  function handleDone(e: MouseEvent<HTMLElement>) {
    e.preventDefault()
    e.stopPropagation()
    wsClient.send({ type: 'control', taskId: task.id, action: 'done' })
    queryClient.setQueryData<Task[]>(['tasks'], (prev = []) =>
      prev.map((t) => (t.id === task.id ? ({ ...t, state: 'releasing' } as Task) : t)),
    )
    queryClient.setQueryData<Task>(['task', task.id], (prev) =>
      prev ? ({ ...prev, state: 'releasing' } as Task) : prev,
    )
    // 仅当 done 的就是当前正在看的 task,才跳回首页;否则停在原页只刷列表
    if (active) navigate({ to: '/' })
  }

  return (
    <li
      ref={liRef}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ position: 'relative' }}
    >
      <Link
        to="/tasks/$taskId"
        params={{ taskId: task.id }}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 8px 8px 10px',
          textDecoration: 'none',
          fontSize: 12,
          color: active ? 'var(--ink-white)' : 'var(--ink-soft)',
          background: active
            ? 'linear-gradient(90deg, rgba(91,200,221,0.12), transparent)'
            : 'rgba(91,200,221,0.03)',
          borderLeft: `2px solid ${
            task.stalled ? 'var(--malice)' : active ? 'var(--cyan)' : 'var(--slate-edge)'
          }`,
          position: 'relative',
          transition: 'background 120ms, color 120ms, border-color 120ms',
          opacity: isDone ? 0.6 : 1,
        }}
      >
        <RoleDot role={role} state={task.state} />
        <span
          title={task.stalled ? `卡住:${task.stalledReason ?? '无进展'}` : undefined}
          style={{
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            textDecoration: isDone ? 'line-through' : 'none',
          }}
        >
          {task.stalled && (
            <span aria-hidden="true" style={{ color: 'var(--malice)', marginRight: 4 }}>
              ⚠
            </span>
          )}
          {task.title}
        </span>
        {/* 右侧槽位:hover 显示 done,非 hover 显示 state badge。两者共用容器尺寸
            (min-width + 同 padding/line-height/border-box),避免 item 高度跳。 */}
        <RightSlot
          showDoneBtn={showDoneBtn}
          active={active}
          label={showDoneBtn ? 'done' : compactState(task.state)}
          {...(showDoneBtn
            ? {
                onClick: handleDone,
                onKeyDown: (e: KeyboardEvent) => {
                  if (e.key === 'Enter' || e.key === ' ')
                    handleDone(e as unknown as MouseEvent<HTMLElement>)
                },
                ariaLabel: `标记 ${task.title} 为 done`,
                title: '标记完成(后台异步判断是否 archive)',
              }
            : {})}
        />
        {active && (
          <span
            className="ab-pulse"
            aria-hidden="true"
            style={{
              position: 'absolute',
              right: 0,
              top: '50%',
              transform: 'translateY(-50%)',
              width: 4,
              height: 14,
              background: 'var(--cyan)',
              boxShadow: '0 0 6px var(--cyan-glow)',
            }}
          />
        )}
      </Link>

    </li>
  )
}

const RoleDot: FC<{ role: string | null; state: Task['state'] }> = ({ role, state }) => {
  if (state === 'done') {
    return (
      <span
        aria-hidden="true"
        style={{
          width: 10,
          height: 10,
          borderRadius: '50%',
          border: '1px solid var(--cyan-dim)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 8,
          color: 'var(--cyan)',
          flexShrink: 0,
        }}
      >
        ✓
      </span>
    )
  }
  if (!role) {
    return (
      <span
        aria-hidden="true"
        style={{
          width: 10,
          height: 10,
          borderRadius: '50%',
          background: 'var(--ink-dimmer)',
          opacity: 0.5,
          flexShrink: 0,
        }}
      />
    )
  }
  return (
    <span
      aria-hidden="true"
      style={{
        width: 10,
        height: 10,
        borderRadius: '50%',
        background: `var(--${role})`,
        boxShadow: `0 0 6px var(--${role})`,
        flexShrink: 0,
      }}
    />
  )
}

function inferSpeakingRole(task: Task): string | null {
  // M3 T1 简化版:不接 chatroom seat-state 实时流,默认按 state 推断主角(T3 chatroom 实现时接实时)
  const map: Record<string, string> = {
    S0: 'planner',
    S1: 'planner',
    S2: 'planner',
    S6: 'engineer',
    S7: 'qa',
    S9: 'ci',
    "S10'": 'planner',
    S11: 'planner',
  }
  return map[task.state] ?? null
}

function compactState(state: Task['state']): string {
  return state.replace("'", '') // S10' → S10
}

/** TaskItem 右侧槽位:hover→done btn,否则 state badge。共用容器尺寸防抖。 */
const RightSlot: FC<{
  showDoneBtn: boolean
  active: boolean
  label: string
  onClick?: (e: MouseEvent<HTMLElement>) => void
  onKeyDown?: (e: KeyboardEvent) => void
  ariaLabel?: string
  title?: string
}> = ({ showDoneBtn, active, label, onClick, onKeyDown, ariaLabel, title }) => (
  <span
    role={showDoneBtn ? 'button' : undefined}
    tabIndex={showDoneBtn ? 0 : undefined}
    onClick={onClick}
    onKeyDown={onKeyDown}
    aria-label={ariaLabel}
    title={title}
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      minWidth: 48,
      height: 18,
      boxSizing: 'border-box',
      flexShrink: 0,
      fontSize: 10,
      fontFamily: 'var(--font-chrome)',
      letterSpacing: '0.12em',
      border: '1px solid transparent',
      borderRadius: 2,
      padding: '0 6px',
      background: showDoneBtn ? 'rgba(91,200,221,0.18)' : 'transparent',
      borderColor: showDoneBtn ? 'var(--cyan)' : 'transparent',
      color: showDoneBtn
        ? 'var(--cyan-bright)'
        : active
          ? 'var(--cyan)'
          : 'var(--ink-dim)',
      fontWeight: showDoneBtn ? 600 : 400,
      textTransform: showDoneBtn ? 'uppercase' : 'none',
      cursor: showDoneBtn ? 'pointer' : 'default',
    }}
  >
    {label}
  </span>
)

function emptyTaskCopy(filter: TaskFilter): string {
  switch (filter) {
    case 'active':
      return '(没有 active 任务)'
    case 'releasing':
      return '(没有 releasing 任务)'
    case 'done':
      return '(没有 done 任务)'
    case 'all':
      return '(该项目暂无任务)'
  }
}
