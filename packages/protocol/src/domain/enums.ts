import { z } from 'zod'

/**
 * 全栈共享的枚举。所有取值与 openspec specs 对齐。
 * 改动这里 = 改动前后端契约，务必同步 specs。
 */

/**
 * 状态机状态。M1 实现 5+1 态，M2 起补 S7（qa 验收）+ S9（ci 监控）。
 * 取值与 design.md D14 transition table 严格一致（含 S10' 的撇号）。
 * 终态：done / aborted / process-crashed。M2+ 再补 S3/S4/S5/S8/S10。
 */
export const TaskState = z.enum([
  'S0', // 任务首页填表
  'S1', // planner 规划
  'S2', // 招募
  'S6', // engineer 实现
  'S7', // qa 验收（M2 m2-qa-role 引入）
  'S9', // ci 监控（M2 m2-ci-factory 引入；MR/CI/comment → ready2merge）
  "S10'", // 等人类（M1 简化态；M2 内 S10 = S10' 不区分）
  'S11', // 复盘
  'releasing', // 收尾编排：agents 在线，planner 产出 retro/archive-plan，资源 release（task-bootstrap-lifecycle D6）
  'done',
  'aborted',
  'process-crashed',
])
export type TaskState = z.infer<typeof TaskState>

/** 后端权威终态集合：这些状态不会再由 task-process 自动推进。*/
export const TERMINAL_TASK_STATES = ['done', 'aborted', 'process-crashed'] as const satisfies readonly TaskState[]
export type TerminalTaskState = (typeof TERMINAL_TASK_STATES)[number]

export function isTerminalTaskState(state: TaskState | string | null | undefined): state is TerminalTaskState {
  return TERMINAL_TASK_STATES.includes(state as TerminalTaskState)
}

/** 工厂角色。M1 只实现 planner + engineer。*/
export const FactoryRole = z.enum(['planner', 'engineer', 'pm-ux', 'qa', 'anti', 'ci'])
export type FactoryRole = z.infer<typeof FactoryRole>

/** agent 生命周期。当前固定 alwaysOn（agent-runtime spec）。*/
export const AgentLifecycle = z.enum(['alwaysOn'])
export type AgentLifecycle = z.infer<typeof AgentLifecycle>

/**
 * 岗位状态机（chatroom-protocol spec）。
 * init→spawn 中 / idle→空闲 / working→处理中 / switching→模型切换中 /
 * offline→idle 被 SIGSTOP / vacant→crash 重 spawn 中。
 */
export const SeatStatus = z.enum(['init', 'idle', 'working', 'switching', 'offline', 'vacant'])
export type SeatStatus = z.infer<typeof SeatStatus>

/**
 * Presence（在场态，derive-presence）：seat 此刻的运行在场,由活 task-process 从其
 * in-memory session map 派生,**不持久化**。取代旧 SeatStatus(6)×AgentRunState(5) 的冗余。
 *   vacant   — 无人在岗(未上场 / 绑定 agent 无 live session)
 *   spawning — 正在拉起(含 model fallback 切换)
 *   working  — 有 live session 且当前 turn 在跑
 *   idle     — 有 live session 但当前无 turn
 *   offline  — 该 task 的 task-process 不在线(前端据 processAlive 渲染)
 */
export const Presence = z.enum(['vacant', 'spawning', 'working', 'idle', 'offline'])
export type Presence = z.infer<typeof Presence>

/** agent 实例运行状态（区别于岗位状态）。*/
export const AgentRunState = z.enum(['init', 'idle', 'working', 'offline', 'terminated'])
export type AgentRunState = z.infer<typeof AgentRunState>

/** agent provider adapter key。选择发生在 agent/seat/factory 级，而不是 task/team 级。*/
export const RuntimeProvider = z.enum(['claude-acp', 'codex-sdk', 'codex-exec'])
export type RuntimeProvider = z.infer<typeof RuntimeProvider>

/** chatroom 频道分层（chatroom-protocol spec）。*/
export const Channel = z.enum(['main', 'eng-internal', 'tool-traces', 'mentions'])
export type Channel = z.infer<typeof Channel>

/** 消息类型。*/
export const MessageType = z.enum([
  'human-msg', // 人类发的
  'agent-text', // agent 自由文本(显式 chatroom_send,人类视角的正式回复)
  'agent-thinking', // agent ACP stream 累积的思考流(默认折叠到"思考中…",展开才看)
  'handoff', // 交接
  'propose', // 状态提议（伴随事件）
  'system-event', // 系统事件（spawn / propose-rejected / phase-change 等）
  'tool-trace', // 工具调用流
])
export type MessageType = z.infer<typeof MessageType>

/** 制品类型枚举（artifact-management spec）。*/
export const ArtifactType = z.enum([
  'proposal',
  'acceptance',
  'visual-contract',
  'design',
  'tasks',
  'decisions',
  'test-report',
  'verification-report',
  'verification-loop',
  'anti-round-1',
  'anti-round-2',
  'ci-report',
  'retrospective',
  'task-plan',
  'phase-notices',
  'other',
])
export type ArtifactType = z.infer<typeof ArtifactType>

/** context_log 的 action 枚举（chatroom-protocol spec）。*/
export const ContextAction = z.enum([
  'read-file',
  'websearch',
  'webfetch',
  'run-cmd',
  'mcp-call',
  'skill-load',
])
export type ContextAction = z.infer<typeof ContextAction>
