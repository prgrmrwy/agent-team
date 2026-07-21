/**
 * 组 16.2: task-process-entry.ts
 * task-process 子进程入口。
 * 由 task-process-launcher.ts 通过 child_process.fork() 启动。
 *
 * 职责：
 *   1. 初始化 per-task DB + orchestrator + TaskMcpContext
 *   2. 启动 chatroom-mcp HTTP server（动态端口）
 *   3. 加载工厂 → spawn planner（S0→S1 启动驱动）
 *   4. 向主 server 发送 lifecycle-ready
 *   5. 监听主 server IPC 消息（user-input / lifecycle-control / heartbeat ping）
 *   6. handleUserInput：human-message → 写 chatroom + prompt planner/engineer session
 *   7. 订阅 EffectEmitter 事件（phase-change / notify / chatroom-msg / recruit / release）
 *   8. recruit → spawn 所有 engineer 岗位
 *   9. release → kill 所有 agentSessions + stop HTTP MCP server + exit
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  isTerminalTaskState,
  isUrgentSystemEvent,
  urgentKeyForContent,
  type Factory,
  type Presence,
  type TaskState,
} from '@agent-team/protocol'
import { resolveRuntimeProvider } from '../adapters/cli/adapter-factory.js'
import { listLocalRuntimes } from '../adapters/cli/local-runtime-discovery.js'
import type { Computer } from '../adapters/cli/computer.js'
import { resolveComputer } from '../adapters/cli/local-computer.js'
import type {
  AgentModelProfile,
  CliAdapter,
  RuntimeDoneEvent,
  RuntimeErrorEvent,
  RuntimeProvider,
  RuntimeTextEvent,
  RuntimeToolEvent,
} from '../adapters/cli/cli-adapter.js'
import { TextAccumulator } from '../adapters/cli/event-mapper.js'
import {
  archiveAgentWorkspace,
  createAgentSettings,
  fallbackCopySkills,
  initAgentWorkspace,
} from '../adapters/fs/agent-workspace-fs.js'
import { probeSymlinks } from '../adapters/fs/symlink-probe.js'
import { releaseAgent } from '../domain/agent/release-agent.js'
import { openDb, runMigrations } from '../db/client.js'
import type { MiniMcpServer, SpawnDeps, SpawnResult } from '../domain/agent/spawn-agent.js'
import { spawnAgent } from '../domain/agent/spawn-agent.js'
import { getFactory, getAllFactories, loadFactories } from '../domain/factory/factory-loader.js'
import { DEFAULT_SYSTEM_DIRECTIVE } from '../domain/factory/system-directive.js'
import { findTransition, driversForState } from '../domain/orchestrator/state-machine.js'
import {
  applyTransitionEffects,
  EffectEmitter,
} from '../domain/orchestrator/transition-effects.js'
import { TaskMcpContext } from '../mcp/mcp-server.js'
import { newSeatId } from '../util/id.js'
import { logger } from '../util/logger.js'
import { persistRuntimeDoneUsage } from './runtime-usage.js'
import type { TaskEvent, UserInput } from './ipc-protocol.js'
import { parseIpcMessage } from './ipc-protocol.js'
import {
  isRuntimeAvailabilityError,
  resolveRuntimeCandidates,
  type RuntimeCandidateResolution,
} from './runtime-resolution.js'
import { classifyWorktreeGate } from './bootstrap-gate.js'
import { TaskBootstrapRunner } from './bootstrap/runner.js'
import { buildDoneSummaryMarkdown } from './done-summary.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// 从父进程传入的环境变量
const _taskId = process.env['TASK_ID']
const _taskWorkdir = process.env['TASK_WORKDIR']
const _taskDbPath = process.env['TASK_DB_PATH']

if (!_taskId || !_taskWorkdir || !_taskDbPath) {
  process.stderr.write('task-process-entry: missing required env vars\n')
  process.exit(1)
}

// 经过 guard 后均为 string（TS 模块级变量无法细化，用 ! 断言）
const taskId: string = _taskId
const taskWorkdir: string = _taskWorkdir
const taskDbPath: string = _taskDbPath
const projectId = process.env['TASK_PROJECT_ID'] ?? parseProjectIdFromTaskWorkdir(taskWorkdir)
const taskTitle = process.env['TASK_TITLE'] ?? '（无标题任务）'
const initialHumanMsg = process.env['TASK_INITIAL_MSG'] ?? ''
const factoriesDir =
  process.env['FACTORIES_DIR'] ?? path.join(__dirname, '../domain/factory/defaults')

// task-level engineer 注入 MCP（JSON array of MiniMcpServer，如 internal-cli stdio）
// 格式：[{"name":"internal-cli","command":"internal-cli","args":["mcp"]}]
let engineerExtraMcps: MiniMcpServer[] = []
if (process.env['TASK_ENGINEER_MCPS']) {
  try {
    engineerExtraMcps = JSON.parse(process.env['TASK_ENGINEER_MCPS']) as MiniMcpServer[]
  } catch {
    process.stderr.write('task-process-entry: invalid TASK_ENGINEER_MCPS JSON, ignoring\n')
  }
}

const log = logger.child({ module: 'task-process', taskId })

log.info({ taskWorkdir }, 'task-process starting')

function parseProjectIdFromTaskWorkdir(workdir: string): string | undefined {
  const match = workdir.match(/\/\.agent-team\/projects\/([^/]+)\/tasks\//)
  return match?.[1]
}

function buildClaudeTelemetryEnv(
  agentId: string,
  factoryName: string,
  endpoint: string,
): Record<string, string> {
  const attrs = [
    `agent_team.project_id=${projectId ?? 'unknown'}`,
    `agent_team.task_id=${taskId}`,
    `agent_team.agent_id=${agentId}`,
    `agent_team.factory=${factoryName}`,
    'agent_team.provider=claude-acp',
  ]
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: endpoint,
    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: endpoint,
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    OTEL_RESOURCE_ATTRIBUTES: attrs.join(','),
  }
}

// 1. 打开 per-task DB
const migrationsDir = path.join(__dirname, '../db/migrations-task')
const db = openDb(taskDbPath, log)
runMigrations(db, migrationsDir, log)
log.info({ taskDbPath }, 'task DB ready')

// 初始化 tasks_meta（幂等，进程重启时已存在则不覆盖）
db.prepare(
  `INSERT OR IGNORE INTO tasks_meta (id, title, state, created_at)
   VALUES (?, ?, 'S0', ?)`,
).run(taskId, taskTitle, new Date().toISOString())

// 2. 初始化 EffectEmitter + TaskMcpContext
const emitter = new EffectEmitter()

// task-bootstrap-lifecycle phase 5.3: orchestrator-owned release hook,exposed to
// task_state_propose MCP tool so releasing→done can push non-terminal bootstrap
// resources into terminal status before validation.
async function releaseBootstrapResources(forTaskId: string): Promise<void> {
  const rows = db
    .prepare(
      `SELECT id FROM bootstrap_resources WHERE task_id = ? AND terminal_status IS NULL`,
    )
    .all(forTaskId) as { id: string }[]
  if (rows.length === 0) return
  // 复用进程已有的 task DB(避免重新 open + migrate),release 之间并行(provider
  // 多为 git subprocess wait,并行无副作用)。
  const runner = new TaskBootstrapRunner({
    db,
    taskWorkdir,
    repoRoot: process.cwd(),
    emit: { systemEvent: () => {} },
  })
  await Promise.all(
    rows.map((row) =>
      runner.release(forTaskId, row.id).catch((err) => {
        log.warn({ err, resourceId: row.id }, 'bootstrap release failed (will fall through to needs-review/retained on next check)')
      }),
    ),
  )
  runner.close()
}

let humanConfirmationPending: {
  messageId: string
  byAgentId: string
  content: string
  markedAt: string
} | null = null

function clearHumanConfirmationPending(reason: string): void {
  if (!humanConfirmationPending) return
  log.info(
    {
      taskId,
      reason,
      messageId: humanConfirmationPending.messageId,
      byAgentId: humanConfirmationPending.byAgentId,
    },
    'human confirmation gate cleared',
  )
  humanConfirmationPending = null
}

const mcpCtx = new TaskMcpContext({
  taskId,
  taskWorkdir,
  db,
  emitter,
  log,
  releaseBootstrapResources,
  isHumanConfirmationPending: () => humanConfirmationPending !== null,
  markHumanConfirmationPending: (input) => {
    humanConfirmationPending = {
      ...input,
      markedAt: new Date().toISOString(),
    }
    log.info(
      { taskId, messageId: input.messageId, byAgentId: input.byAgentId },
      'human confirmation gate marked pending',
    )
  },
  clearHumanConfirmationPending,
})

// ─── 防静默栈(phase-driven-orchestration: task-lifecycle 防静默)───────────────
// 进展信号刷新点:phase-change / driver chatroom 消息 / tool-trace / markWorking。
let lastProgressAt = Date.now()
// 本 phase 内每个 seat 的空转软推计数,phase-change 时清零(上限 2)。
const idleNudgeCount = new Map<string, number>()
const IDLE_NUDGE_CAP = 2
// 每个 agent 本 turn 起始时间(判 deliverable 是否本 turn 更新)。
const turnStartAtByAgent = new Map<string, number>()
// 本 turn 是否 propose 过(tool 名含 task_state_propose)。
const proposedThisTurnByAgent = new Set<string>()
// stalled 幂等标志(已升级不重复通知)。
let isStalledFlag = false
const WATCHDOG_TIMEOUT_MS = 10 * 60 * 1000 // 10min
const WATCHDOG_TICK_MS = 2 * 60 * 1000 // 2min

// 人类急停(ESC ESC):打断所有在跑 turn + 门控一切新唤醒,直到人类发消息/恢复。
// 防静默(idle-nudge / watchdog)和编排唤醒(phase / mention / gate)全部对它让路。
let humanPaused = false

function markProgress(_reason: string): void {
  lastProgressAt = Date.now()
  if (isStalledFlag) clearStalled()
}

/** 当前 task state */
function currentTaskState(): string {
  const row = db.prepare('SELECT state FROM tasks_meta WHERE id = ?').get(taskId) as
    | { state: string }
    | undefined
  return row?.state ?? 'S0'
}

/** 升级:置 stalled + 桌面通知 + urgent chatroom;幂等(已 stalled 不重复)*/
function escalateStalled(reason: string): void {
  if (isStalledFlag) return
  isStalledFlag = true
  process.send?.({
    type: 'task-event',
    subtype: 'stalled',
    taskId,
    stalled: true,
    reason,
  } satisfies TaskEvent)
  process.send?.({
    type: 'task-event',
    subtype: 'notification',
    taskId,
    level: 'error',
    content: `任务卡住(${reason}),需人类介入。`,
  } satisfies TaskEvent)
  writeChatroomMsg(
    'system',
    'main',
    'system-event',
    `⚠️ 任务卡住:${reason}。当前阶段无人推进,请人类介入(检查 agent 是否卡死 / 缺信息)。`,
  )
}

function clearStalled(): void {
  if (!isStalledFlag) return
  isStalledFlag = false
  process.send?.({
    type: 'task-event',
    subtype: 'stalled',
    taskId,
    stalled: false,
  } satisfies TaskEvent)
}

/**
 * idle-entry 生产力检查:driver turn 结束时若空转(本 turn 无 propose / 无 deliverable 更新 /
 * 无阻塞消息)→ 软推(上限 2),超限升级。
 */
function checkIdleProductivity(agentId: string, seatId: string | null): void {
  if (humanPaused) return // 急停期间不软推/不升级
  if (!seatId) return
  const seatRow = db.prepare('SELECT factory FROM seats WHERE id = ?').get(seatId) as
    | { factory: string }
    | undefined
  if (!seatRow) return
  const state = currentTaskState()
  // 只对"当前 state 的 driver"做检查
  const factories = getAllFactories().map((f) => ({
    name: f.name,
    proposeTransitions: f.defaultPermissions.proposeTransitions,
  }))
  if (!driversForState(state as TaskState, factories).includes(seatRow.factory)) return

  const turnStart = turnStartAtByAgent.get(agentId) ?? 0
  const proposed = proposedThisTurnByAgent.has(agentId)
  const communicated = chatroomSendThisTurnByAgent.get(agentId) ?? false
  const deliverableUpdated = factoryDeliverableUpdatedSince(seatRow.factory, turnStart)
  const progressed = proposed || communicated || deliverableUpdated
  if (progressed) return

  // 空转
  const key = `${seatId}:${state}`
  const n = (idleNudgeCount.get(key) ?? 0) + 1
  idleNudgeCount.set(key, n)
  if (n <= IDLE_NUDGE_CAP) {
    log.warn({ seatId, state, nudge: n }, 'idle-entry: 空转 turn,软推')
    wake(
      seatId,
      `你这一轮结束了但没推进(没 propose、没更新产物、也没报阻塞)。请继续:要么完成产出并 task_state_propose,要么 @ 上游催进展,要么明确说你卡在哪。`,
    ).catch((err) => log.error({ err, seatId }, 'idle nudge wake failed'))
  } else {
    escalateStalled(`${seatRow.factory} 在 ${state} 连续 ${n - 1} 轮空转`)
  }
}

/** factory.deliverables 任一文件在 since 之后被修改 */
function factoryDeliverableUpdatedSince(factoryName: string, since: number): boolean {
  const f = getFactory(factoryName)
  if (!f) return false
  for (const rel of f.deliverables) {
    // deliverable 可能带版本号占位(<n>),取目录粗判:扫目录里匹配前缀的文件 mtime
    const dir = path.join(taskWorkdir, path.dirname(rel))
    if (!fs.existsSync(dir)) continue
    try {
      for (const file of fs.readdirSync(dir)) {
        const stat = fs.statSync(path.join(dir, file))
        if (stat.mtimeMs > since) return true
      }
    } catch {
      // ignore
    }
  }
  return false
}

/** timer watchdog:卡 working 永不 done / 长时间无任何进展 → 升级 */
function runWatchdogTick(): void {
  if (humanPaused) return // 急停是人类有意为之,不算"卡住"
  const state = currentTaskState()
  if (isTerminalTaskState(state)) return
  if (Date.now() - lastProgressAt <= WATCHDOG_TIMEOUT_MS) return
  // 超时:确认当前 state 有 driver 且其 seat 存在(无 driver 的 S10' 等人类,不算卡)
  const factories = getAllFactories().map((f) => ({
    name: f.name,
    proposeTransitions: f.defaultPermissions.proposeTransitions,
  }))
  const drivers = driversForState(state as TaskState, factories)
  if (drivers.length === 0) return // 等人类阶段,不报警
  escalateStalled(`${state} 阶段超 ${WATCHDOG_TIMEOUT_MS / 60000}min 无任何进展`)
}

// 3. 订阅 EffectEmitter → IPC task-event
// phase-change dispatcher(phase-driven-orchestration):
//   1. 广播 IPC
//   2. 系统副作用(done summary / S2 gate-advance);notify/release 由 transition-effects 处理
//   3. 进态驱动唤醒:driversForState(to) → 每个 driver seat:vacant→懒spawn / idle→通用唤醒
emitter.on('phase-change', (evt) => {
  const msg: TaskEvent = {
    type: 'task-event',
    subtype: 'phase-change',
    taskId: evt.taskId,
    from: evt.from,
    to: evt.to,
    by: evt.by,
    at: evt.at,
  }
  process.send?.(msg)

  // 阶段进度刷新(watchdog)+ 清空上一阶段的空转软推计数
  markProgress('phase-change')
  idleNudgeCount.clear()

  if (evt.to === 'done') {
    // 任务真正 done 后,在 chatroom 留一条系统总结 — 用户能直观看到收尾结果。
    // 在 release event(下面)真正 kill agents + db.close() 前同步写,这样消息能进表 + 广播。
    try {
      writeDoneSummary(evt.from)
    } catch (err) {
      log.warn({ err }, 'writeDoneSummary failed (non-fatal)')
    }
    return
  }

  // S2 瞬时 gate:纯懒式下 S2 不 spawn 任何 agent,校验 seatPlan 后立即跳 S6
  if (evt.to === 'S2') {
    gateAdvanceS2()
    return
  }

  // 进态驱动唤醒(S6 eng / S7 qa / S9 ci / S11,releasing planner)
  wakeDriversForPhase(evt.to)
})

/**
 * 进态驱动唤醒:找活跃于该状态的角色,唤醒其 seat。
 * vacant → 懒 spawn(spawnEngineerForSeat 自带 rich 首 prompt);idle → 通用 re-wake;working → 排队不打断。
 */
function wakeDriversForPhase(state: TaskState): void {
  if (humanPaused) {
    log.info({ state }, 'wakeDriversForPhase skipped — humanPaused')
    return
  }
  const factories = getAllFactories().map((f) => ({
    name: f.name,
    proposeTransitions: f.defaultPermissions.proposeTransitions,
  }))
  const driverRoles = driversForState(state, factories)
  if (driverRoles.length === 0) return
  for (const role of driverRoles) {
    const seats = db
      .prepare(`SELECT id FROM seats WHERE task_id = ? AND factory = ?`)
      .all(taskId, role) as { id: string }[]
    for (const seat of seats) {
      wake(seat.id, genericPhasePrompt(state, role)).catch((err) => {
        log.error({ err, seatId: seat.id, state, role }, 'wakeDriversForPhase: wake failed')
      })
    }
  }
}

/** 通用进态唤醒文本 — 不含角色细节(细节在 agent 自己的 systemPromptTemplate)*/
function genericPhasePrompt(state: TaskState, role: string): string {
  return [
    `任务进入 ${state}。按状态机,现在轮到你(${role})。`,
    '',
    '- 先确认你的输入产物是否就绪(artifact_get / chatroom_recent)。',
    '- 就绪 → 立刻按你的职责开始,完成后 task_state_propose 推进下一阶段。',
    '- 没就绪 → chatroom_send @ 上游角色催进展,说清你在等什么,不要静默 idle。',
  ].join('\n')
}

/**
 * 统一 wake 原语(agent-runtime "统一 wake 原语"):
 *   vacant / 无 agent → 懒 spawn(spawnEngineerForSeat,用其 rich 首 prompt,忽略 generic)
 *   idle → promptSession(generic re-wake)
 *   working → 不打断(promptSession 会排队,turn 结束消费)
 */
async function wake(seatId: string, prompt: string): Promise<void> {
  const seat = db
    .prepare(`SELECT id FROM seats WHERE id = ?`)
    .get(seatId) as { id: string } | undefined
  if (!seat) {
    log.warn({ seatId }, 'wake: seat not found')
    return
  }
  const agentId = seatToAgent.get(seatId)
  if (!agentId) {
    await spawnEngineerForSeat(seatId)
    return
  }
  const sessionId = agentSessions.get(agentId)
  if (!sessionId) {
    // seat 标记有 agent,但本进程内没有它的 live session —— 典型:task-process relaunch 后
    // seat 还停在旧的 idle/working,但 agent 已随上个进程死了。当作需要重新上场 → re-spawn,
    // 不能静默 return(否则 relaunch 进 releasing 时 planner 永远醒不过来,卡死收尾)。
    log.info(
      { seatId, agentId },
      'wake: stale seat (no live session in this process) → respawn',
    )
    await spawnEngineerForSeat(seatId)
    return
  }
  // working:promptSession 排队;idle:立即重激活。两者都 promptSession。
  promptSession(sessionId, prompt).catch((err: unknown) => {
    log.error({ seatId, err }, 'wake: promptSession failed')
  })
}

/** S2 瞬时 gate:seatPlan 有 engineer seat → 立即 advanceState S2→S6;否则等 planner 补齐 */
// S2 是瞬时 gate:engineer seat 就绪即跳 S6。两个触发点都调它(幂等):
//   ① phase-change 进 S2 时(planner 先建 seat 再 propose 的正常序)
//   ② seat-created 时(planner 先 propose S2 再建 seat 的乱序 — 否则永久死锁)
function gateAdvanceS2(): void {
  if (humanPaused) return
  if (currentTaskState() !== 'S2') return // 只在 S2 gate;非 S2 调用是 no-op
  const engSeat = db
    .prepare(`SELECT id FROM seats WHERE task_id = ? AND factory = 'engineer' LIMIT 1`)
    .get(taskId) as { id: string } | undefined
  if (!engSeat) {
    log.warn({ taskId }, 'gateAdvanceS2: seatPlan 无 engineer seat,暂不 advance(等 seat-created 补触发)')
    return
  }
  advanceState('S2', 'S6', 'system')
}

/** 把任意 thrown 值(Error / 普通对象 / 字符串)转成可读字符串 — String(obj)="[object Object]" 没用 */
function errorDetail(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  if (err && typeof err === 'object') {
    // 优先看常见错误字段
    const obj = err as Record<string, unknown>
    if (typeof obj['message'] === 'string') return obj['message'] as string
    if (typeof obj['error'] === 'string') return obj['error'] as string
    if (typeof obj['code'] === 'string' || typeof obj['code'] === 'number') {
      return `code=${String(obj['code'])}${obj['details'] ? ' ' + JSON.stringify(obj['details']) : ''}`
    }
    try {
      return JSON.stringify(err)
    } catch {
      return Object.prototype.toString.call(err)
    }
  }
  return String(err)
}

function writeDoneSummary(fromState: string): void {
  const content = buildDoneSummaryMarkdown(db, taskId, fromState)
  writeChatroomMsg('system', 'main', 'system-event', content)
}

emitter.on('notify', (evt) => {
  const msg: TaskEvent = {
    type: 'task-event',
    subtype: 'notification',
    taskId: evt.taskId,
    level: evt.level,
    content: evt.content,
  }
  process.send?.(msg)
})

emitter.on('chatroom-msg', (evt) => {
  const msgEvt: TaskEvent = {
    type: 'task-event',
    subtype: 'chatroom-msg',
    taskId: evt.taskId,
    message: evt.message,
  }
  process.send?.(msgEvt)
})

// wakeup-seat:mention 命中 idle/offline/vacant seat → 统一走 wake 原语
// (phase-driven-orchestration: chatroom-protocol "mention 唤醒 idle agent")。
// vacant→懒spawn / idle→promptSession 让被 @ 的 agent 处理 mention,实现 peer 催单闭环。
emitter.on('wakeup-seat', (evt: { taskId: string; seatId: string }) => {
  if (humanPaused) return
  wake(
    evt.seatId,
    [
      '你被 @ 了。请查看 main 频道最新消息并处理。',
      '如果消息来自 QA 且包含 FAIL/回修项/等待第 2 轮产物,这不是单纯确认请求,而是要求你继续修复:立即读取 qa/verification_report*.md,定位失败项,修改代码、补测试、commit、写新一轮 eng/test-report-<n>.md 与 eng/commits-<n>.txt,再交回 QA。',
      '不要只回复"收到/下一步应继续"后停下;只有对方明确要求暂停、等待确认,或缺少必要信息时,才在 chatroom 说明阻塞并等待。',
      '普通催交付则确认产物就绪后推进;纯提问才在 chatroom 回复。',
    ].join('\n'),
  ).catch((err) => {
    log.error({ err, seatId: evt.seatId }, 'wakeup-seat: wake failed')
  })
})

// (recruit 事件已删 — phase-driven 下 spawn 由 phase-change dispatcher 的通用懒 spawn
//  统一处理:进 S6 懒 spawn engineer、S7 懒 spawn qa、S9 懒 spawn ci。S2→S6 由 gateAdvanceS2。)

// seat-created:engineer seat 建好时若卡在 S2 → 补触发 gate(消除"先 propose S2 再建 seat"的死锁)
emitter.on('seat-created', (evt: { taskId: string; seatId: string; factory: string }) => {
  publishPresence(evt.seatId, null, null)
  if (evt.factory === 'engineer') gateAdvanceS2()
})

// release 事件:done/aborted 时 kill 所有 agent + 关 MCP server + 退出。
// 以 DB 为准遍历所有非 terminated agent(含上代 task-process 留下的孤儿)— 之前
// 只看 agentSessions 会漏 engineer/qa 等本进程没拿到 session 的 agent,导致
// done 后 DB 里仍有 idle 状态的 agent + idle 的 seat。
emitter.on('release', (evt: { taskId: string; reason: 'done' | 'aborted' }) => {
  log.info({ reason: evt.reason }, 'release event received — shutting down all agents')
  const liveAgents = db
    .prepare("SELECT id FROM agents WHERE task_id = ? AND state != 'terminated'")
    .all(taskId) as { id: string }[]
  Promise.all(
    liveAgents.map(async ({ id: agentId }) => {
      const sessionId = agentSessions.get(agentId)
      try {
        if (sessionId) {
          // 本进程持有 session:完整 release(killCli + archiveWorkspace)
          await releaseAgent({
            taskWorkdir,
            agentId,
            sessionId,
            reason: evt.reason,
            deps: {
              killCli: killSession,
              archiveWorkspace: archiveAgentWorkspace,
            },
          })
        } else {
          // 孤儿 agent:上代 task-process 死时 session 一并丢,无 cli 可 kill;
          // 仅尝试 archive workspace(失败也忽略,不阻塞终态写入)
          try {
            archiveAgentWorkspace(taskWorkdir, agentId)
          } catch (err) {
            log.warn({ err, agentId }, 'archive orphan agent workspace failed')
          }
        }
      } catch (err) {
        log.warn({ err, agentId }, 'release agent failed')
      } finally {
        const terminatedAt = new Date().toISOString()
        db.prepare(
          "UPDATE agents SET state = 'terminated', terminated_at = ? WHERE id = ?",
        ).run(terminatedAt, agentId)
        agentSessions.delete(agentId)
        turnRunningAgents.delete(agentId)
      }
    }),
  ).finally(() => {
    mcpCtx
      .stopHttpServer()
      .catch(() => {})
      .finally(() => {
        db.close()
        process.exit(0)
      })
  })
})

// (buildRetroPrompt / retro-start handler 已删 — phase-driven 下 releasing/S11 由
//  phase-change dispatcher 把 planner 作为 driver 通用唤醒;retro 详细步骤迁入 planner.yaml
//  systemPromptTemplate,agent 自取。)

// sessionId map：agentId → ACP sessionId
const agentSessions = new Map<string, string>()
// seatId → agentId（用于 mention 路由）
const seatToAgent = new Map<string, string>()
// 正在 spawn/fallback 的 seat。presence 派生时优先显示 spawning。
const spawningSeats = new Set<string>()
// 当前 turn 正在跑的 agent。presence 派生时显示 working。
const turnRunningAgents = new Set<string>()
// planner agentId（spawn 后记录，用于路由 human-msg）
let plannerAgentId: string | null = null
// usedNames 跨所有 agent 共享（planner + engineer）
const usedNames = new Set<string>()

// Computer：agent 运行时执行基底（M1 默认 LocalComputer，同机零行为变化）。
// 解析按 agent 级（seat override → factory preferred → env → 'local'）；M1 全为 local。
const computer: Computer = resolveComputer()

// Provider adapter registry：同一个 task 内可混用多个 provider；选择发生在 agent spawn 时。
const runtimeAdapters = new Map<RuntimeProvider, CliAdapter>()
const sessionAdapters = new Map<string, CliAdapter>()
const probingSessions = new Set<string>()
const fallbackInProgressAgents = new Set<string>()

function getRuntimeAdapter(modelProfile?: AgentModelProfile): CliAdapter {
  const provider = modelProfile?.provider ?? resolveRuntimeProvider()
  let adapter = runtimeAdapters.get(provider)
  if (!adapter) {
    adapter = computer.createCliAdapter(provider)
    attachRuntimeAdapterListeners(adapter)
    runtimeAdapters.set(provider, adapter)
  }
  return adapter
}

function promptSession(sessionId: string, prompt: string): Promise<void> {
  const adapter = sessionAdapters.get(sessionId)
  if (!adapter) return Promise.reject(new Error(`runtime adapter not found for session: ${sessionId}`))
  return adapter.prompt(sessionId, prompt)
}

function pauseSession(sessionId: string): void {
  sessionAdapters.get(sessionId)?.pause(sessionId)
}

function interruptSession(sessionId: string): void {
  sessionAdapters.get(sessionId)?.interrupt(sessionId)
}

function resumeSession(sessionId: string): void {
  sessionAdapters.get(sessionId)?.resume(sessionId)
}

function resumeFromHumanPause(reason: string): void {
  if (!humanPaused) return
  humanPaused = false
  for (const sid of agentSessions.values()) resumeSession(sid)
  log.info({ taskId, reason }, 'human pause cleared by control action')
}

function killSession(sessionId: string): Promise<void> {
  const adapter = sessionAdapters.get(sessionId)
  if (!adapter) return Promise.resolve()
  return adapter.kill(sessionId).finally(() => sessionAdapters.delete(sessionId))
}

function resolveAgentModelProfile(factory: {
  preferredModelProfile?: AgentModelProfile
}): AgentModelProfile {
  if (factory.preferredModelProfile) return factory.preferredModelProfile
  return { provider: resolveRuntimeProvider() }
}

async function resolveRuntimeCandidatesForSpawn(
  factory: {
    preferredModelProfile?: AgentModelProfile
    fallbackModelProfiles?: AgentModelProfile[]
  },
  modelOverride?: string | null,
): Promise<RuntimeCandidateResolution> {
  if (modelOverride) {
    try {
      JSON.parse(modelOverride)
    } catch (err) {
      log.warn({ err }, 'invalid seat model_override JSON; falling back to factory/default model profile')
      modelOverride = null
    }
  }

  const resolution = resolveRuntimeCandidates({
    factory: {
      ...factory,
      fallbackModelProfiles: factory.fallbackModelProfiles ?? [],
    },
    modelOverride,
    localRuntimes: await listLocalRuntimes(),
  })
  if (resolution.skipped.length > 0) {
    const skipped = resolution.skipped
      .map((s) => `${s.modelProfile.provider}${s.modelProfile.model ? `/${s.modelProfile.model}` : ''}: ${s.reason}`)
      .join('; ')
    log.warn({ skipped }, 'skipping unavailable local provider candidates')
    process.send?.({
      type: 'task-event',
      subtype: 'notification',
      taskId,
      level: 'warn',
      content: `已跳过不可用 provider/model：${skipped}`,
    } satisfies TaskEvent)
  }
  return resolution
}

async function spawnWithRuntimeFallback(
  label: string,
  candidates: AgentModelProfile[],
  spawn: (modelProfile: AgentModelProfile) => Promise<Awaited<ReturnType<typeof spawnAgent>>>,
): Promise<Awaited<ReturnType<typeof spawnAgent>>> {
  let lastErr: unknown
  for (let i = 0; i < candidates.length; i += 1) {
    const modelProfile = candidates[i]!
    try {
      if (i > 0) {
        process.send?.({
          type: 'task-event',
          subtype: 'notification',
          taskId,
          level: 'warn',
          content: `${label} 改用 fallback provider/model：${modelProfile.provider}${modelProfile.model ? `/${modelProfile.model}` : ''}`,
        } satisfies TaskEvent)
      }
      return await spawn(modelProfile)
    } catch (err) {
      lastErr = err
      if (i < candidates.length - 1 && isRuntimeAvailabilityError(err)) {
        log.warn(
          {
            label,
            provider: modelProfile.provider,
            err: err instanceof Error ? err.message : String(err),
          },
          'provider/model availability failure; trying fallback',
        )
        continue
      }
      throw err
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr ?? 'no runtime candidates'))
}

function modelProfileLabel(modelProfile?: AgentModelProfile | null): string {
  if (!modelProfile) return 'default provider/model'
  return [
    modelProfile.provider,
    modelProfile.model,
    modelProfile.reasoningEffort ? `effort=${modelProfile.reasoningEffort}` : null,
  ].filter(Boolean).join(' / ')
}

function isSameModelProfile(a?: AgentModelProfile | null, b?: AgentModelProfile | null): boolean {
  if (!a || !b) return false
  return (
    a.provider === b.provider &&
    (a.model ?? '') === (b.model ?? '') &&
    (a.cliBinary ?? '') === (b.cliBinary ?? '') &&
    (a.reasoningEffort ?? '') === (b.reasoningEffort ?? '')
  )
}

function parseModelProfileSnapshot(raw: unknown): AgentModelProfile | undefined {
  if (!raw || typeof raw !== 'string') return undefined
  try {
    const parsed = JSON.parse(raw) as AgentModelProfile
    return parsed && typeof parsed.provider === 'string' ? parsed : undefined
  } catch {
    return undefined
  }
}

function emitSeatPresence(
  seatId: string,
  presence: Presence,
  agentId: string | null,
  displayName: string | null,
): void {
  process.send?.({
    type: 'task-event',
    subtype: 'seat-state',
    taskId,
    seatId,
    presence,
    agentId,
    displayName,
  } satisfies TaskEvent)
}

function boundAgentForSeat(seatId: string): string | null {
  return seatToAgent.get(seatId) ?? null
}

function derivePresence(seatId: string): Presence {
  if (spawningSeats.has(seatId)) return 'spawning'
  const agentId = boundAgentForSeat(seatId)
  if (!agentId) return 'vacant'
  if (!agentSessions.has(agentId)) return 'vacant'
  return turnRunningAgents.has(agentId) ? 'working' : 'idle'
}

function publishPresence(
  seatId: string,
  agentId: string | null = boundAgentForSeat(seatId),
  displayName: string | null = null,
): void {
  emitSeatPresence(seatId, derivePresence(seatId), agentId, displayName)
}

async function cleanupFailedSpawn(result: SpawnResult): Promise<void> {
  usedNames.delete(result.displayName)
  agentSessions.delete(result.agentId)
  textAccumulators.delete(result.agentId)
  await killSession(result.sessionId).catch((err) => {
    log.warn({ err, agentId: result.agentId }, 'failed to kill failed probe session')
  })
  await mcpCtx.unregisterAgent(result.agentId).catch((err) => {
    log.warn({ err, agentId: result.agentId }, 'failed to unregister failed probe MCP transport')
  })
}

async function probeSpawnedAgent(label: string, result: SpawnResult): Promise<void> {
  if (process.env['AGENT_TEAM_MODEL_PROBE'] === '0') return
  const prompt = [
    'System capability probe.',
    'Reply with exactly: OK',
    'Do not call tools.',
  ].join('\n')

  probingSessions.add(result.sessionId)
  try {
    await promptSession(result.sessionId, prompt)
    log.info(
      { label, agentId: result.agentId, modelProfile: result.modelProfile },
      'model profile probe passed',
    )
  } catch (err) {
    await cleanupFailedSpawn(result)
    log.warn(
      {
        label,
        agentId: result.agentId,
        modelProfile: result.modelProfile,
        err: err instanceof Error ? err.message : String(err),
      },
      'model profile probe failed',
    )
    throw err
  } finally {
    probingSessions.delete(result.sessionId)
  }
}

async function spawnAgentWithProbe(opts: {
  label: string
  factory: Factory
  runtime: AgentModelProfile
  initialPrompt: string
  extraMcps?: MiniMcpServer[]
  deps: SpawnDeps
  /** override taskWorktree (Phase 4.1): pass ready worktree resource path; '' to skip injection */
  taskWorktree?: string
  /** 复用上次 displayName(若 seat 上一个 agent 有);防 server 重启后改名 */
  seatId?: string
}): Promise<SpawnResult> {
  const preferredDisplayName = opts.seatId ? lastDisplayNameForSeat(opts.seatId) : undefined
  const result = await spawnAgent({
    taskWorkdir,
    factory: opts.factory,
    usedNames,
    taskWorktree: opts.taskWorktree ?? '',
    extraMcps: opts.extraMcps ?? [],
    runtime: opts.runtime,
    initialPrompt: opts.initialPrompt,
    deps: opts.deps,
    ...(preferredDisplayName ? { preferredDisplayName } : {}),
  })
  await probeSpawnedAgent(opts.label, result)
  return result
}

/** 查 seat 历史 agent 的 displayName(最新的) */
function lastDisplayNameForSeat(seatId: string): string | undefined {
  try {
    const row = db
      .prepare(
        'SELECT display_name FROM agents WHERE seat_id = ? ORDER BY spawned_at DESC LIMIT 1',
      )
      .get(seatId) as { display_name?: string } | undefined
    return row?.display_name && row.display_name.length > 0 ? row.display_name : undefined
  } catch {
    return undefined
  }
}

/**
 * Phase 4.1: read primary worktree resource. Returns null when not present.
 * spawnAgent should only inject the worktree into additionalDirectories when ready.
 */
function readPrimaryWorktreeResource(): {
  status: string
  path: string | null
  branch: string | null
  provider: string
  mode: string | null
  summary: string | null
  error: string | null
} | null {
  const row = db
    .prepare(
      `SELECT status, path, branch, provider, mode, summary, error
         FROM bootstrap_resources
        WHERE task_id = ? AND id = 'primary-worktree'`,
    )
    .get(taskId) as
    | {
        status: string
        path: string | null
        branch: string | null
        provider: string
        mode: string | null
        summary: string | null
        error: string | null
      }
    | undefined
  return row ?? null
}

/** Resolve worktree path to inject as additionalDirectories. '' when not ready. */
function resolveSpawnWorktreePath(): string {
  const row = readPrimaryWorktreeResource()
  if (row && row.status === 'ready' && row.path) return row.path
  return ''
}

/**
 * Phase 4.3: gate engineer/qa/ci spawn on worktree readiness.
 *
 * - resource absent (provider=none) → ok (no worktree expected; agent works in task workdir)
 * - status=ready → ok
 * - status=creating → poll up to timeout; ready→ok, failed→fail
 * - status=failed → fail and surface error + retry hint
 *
 * On fail, emits chatroom system-event + task-event notification so user can retry.
 */
async function awaitWorktreeReadyGate(
  seatId: string,
  factoryName: string,
): Promise<{ ok: boolean }> {
  const pollMs = Number(process.env['AGENT_TEAM_BOOTSTRAP_GATE_POLL_MS'] ?? 500)
  const timeoutMs = Number(process.env['AGENT_TEAM_BOOTSTRAP_GATE_TIMEOUT_MS'] ?? 5 * 60_000)
  const start = Date.now()

  while (true) {
    const row = readPrimaryWorktreeResource()
    const decision = classifyWorktreeGate(row?.status ?? null)
    if (decision === 'ok') return { ok: true }
    if (decision === 'fail') {
      const errText = row?.error ? `(${row.error})` : ''
      const msg = `${factoryName} 招募被阻塞:bootstrap worktree 状态为 failed${errText}。请前端 retry bootstrap 后再招募。`
      log.error({ seatId, factory: factoryName, err: row?.error }, 'worktree gate: failed')
      writeChatroomMsg('system', 'main', 'system-event', msg)
      process.send?.({
        type: 'task-event',
        subtype: 'notification',
        taskId,
        level: 'error',
        content: msg,
      } satisfies TaskEvent)
      return { ok: false }
    }
    // wait (creating / terminal post-release / other) — timeout-bounded
    if (Date.now() - start > timeoutMs) {
      const msg = `${factoryName} 招募超时:bootstrap worktree 仍为 \`${row?.status ?? 'unknown'}\` 超过 ${Math.round(
        timeoutMs / 1000,
      )}s。请检查 bootstrap provider 状态。`
      log.error({ seatId, factory: factoryName, status: row?.status }, 'worktree gate: timeout')
      writeChatroomMsg('system', 'main', 'system-event', msg)
      process.send?.({
        type: 'task-event',
        subtype: 'notification',
        taskId,
        level: 'error',
        content: msg,
      } satisfies TaskEvent)
      return { ok: false }
    }
    await new Promise((r) => setTimeout(r, pollMs))
  }
}

/**
 * 渲染 factory 的 systemPromptBase:systemDirective(系统层,最前)+ systemPromptTemplate(角色职责,
 * 内联 agent.md)。phase-driven-orchestration: factory-system "systemDirective 渲染顺序"。
 */
function renderSystemPromptBase(
  factory: Factory,
  taskTitle: string,
  agentMdContent: string,
  displayName?: string,
): string {
  let base = factory.systemPromptTemplate
    .replace('{{task.title}}', taskTitle)
    .replace('{{> agent.md}}', agentMdContent)
  if (displayName) base = base.replace('{{displayName}}', displayName)
  const directive = factory.systemDirective ?? DEFAULT_SYSTEM_DIRECTIVE
  return `${directive}\n\n---\n\n${base}`
}

function buildModelFallbackPrompt(
  factory: Factory,
  displayName: string,
  oldDisplayName: string,
  error: RuntimeErrorEvent,
): string {
  const agentMdPath = path.join(__dirname, '../../../../agent.md')
  const agentMdContent = fs.existsSync(agentMdPath) ? fs.readFileSync(agentMdPath, 'utf-8') : ''
  const systemPromptBase = renderSystemPromptBase(factory, taskTitle, agentMdContent, displayName)

  return [
    systemPromptBase,
    '',
    '---',
    '## 模型 fallback 接管指示',
    '',
    `你是 ${displayName}（${factory.name}），刚刚因上一个 agent ${oldDisplayName} 的 provider/model 达到限制而被重新实例化接管。`,
    `触发原因：${error.provider}/${error.reason} - ${error.message}`,
    '',
    '请立即执行：',
    '1. 调用 `chatroom_recent` 读取 main 频道最近 50 条消息，恢复任务上下文。',
    '2. 调用 `artifact_list` 检查已有计划、验收、测试或阶段制品。',
    '3. 在 main 频道发一条简短消息说明你已接管，并继续当前阶段工作。',
    '',
    '不要重新规划整条任务；优先从已有 chatroom 与 artifacts 接续。',
  ].join('\n')
}

async function switchAgentModelProfile(agentId: string, error: RuntimeErrorEvent): Promise<void> {
  if (fallbackInProgressAgents.has(agentId)) return
  fallbackInProgressAgents.add(agentId)

  try {
    const old = db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId) as
      | {
          id: string
          seat_id: string
          factory: string
          display_name: string
          model_profile: string | null
        }
      | undefined
    if (!old) return

    const seatRow = db.prepare('SELECT id, factory FROM seats WHERE id = ?').get(old.seat_id) as
      | { id: string; factory: string }
      | undefined
    if (!seatRow) return

    const factory = getFactory(old.factory)
    if (!factory) {
      log.error({ factory: old.factory, agentId }, 'cannot fallback: factory not found')
      return
    }

    const currentModelProfile = parseModelProfileSnapshot(old.model_profile)
    const runtimeResolution = await resolveRuntimeCandidatesForSpawn(factory, null)
    const candidates = runtimeResolution.candidates.filter(
      (candidate) => !isSameModelProfile(candidate, currentModelProfile),
    )

    if (candidates.length === 0) {
      const detail = `没有可用 fallback provider/model（current=${modelProfileLabel(currentModelProfile)}）`
      log.error({ agentId, currentModelProfile }, detail)
      writeChatroomMsg('system', 'main', 'system-event', `${old.display_name} 模型受限，但 ${detail}。`)
      process.send?.({
        type: 'task-event',
        subtype: 'notification',
        taskId,
        level: 'error',
        content: `${old.display_name} 模型 fallback 失败：${detail}`,
      } satisfies TaskEvent)
      return
    }

    spawningSeats.add(old.seat_id)
    publishPresence(old.seat_id, old.id, old.display_name)
    const nextModelProfile = candidates[0]
    writeChatroomMsg(
      'system',
      'main',
      'system-event',
      `${old.display_name} 的 ${modelProfileLabel(currentModelProfile)} 达到限制，正在切换到 fallback ${modelProfileLabel(nextModelProfile)}。`,
    )
    process.send?.({
      type: 'task-event',
      subtype: 'notification',
      taskId,
      level: 'warn',
      content: `${old.display_name} 正在切换模型：${modelProfileLabel(currentModelProfile)} → ${modelProfileLabel(nextModelProfile)}`,
    } satisfies TaskEvent)

    const oldSessionId = agentSessions.get(old.id)
    if (oldSessionId) await killSession(oldSessionId)
    await mcpCtx.unregisterAgent(old.id).catch((err) => {
      log.warn({ err, agentId: old.id }, 'failed to unregister old fallback agent MCP transport')
    })
    const terminatedAt = new Date().toISOString()
    db.prepare("UPDATE agents SET state = 'terminated', terminated_at = ? WHERE id = ?").run(
      terminatedAt,
      old.id,
    )
    agentSessions.delete(old.id)
    turnRunningAgents.delete(old.id)
    seatToAgent.delete(old.seat_id)
    textAccumulators.delete(old.id)
    if (plannerAgentId === old.id) plannerAgentId = null

    const replacementPromptPlaceholder = buildModelFallbackPrompt(factory, '待确定', old.display_name, error)
    const spawnResult = await spawnWithRuntimeFallback(
      `${old.factory} runtime fallback`,
      candidates,
      (modelProfile) =>
        spawnAgentWithProbe({
          label: `${old.factory} runtime fallback`,
          factory,
          runtime: modelProfile,
          initialPrompt: replacementPromptPlaceholder,
          extraMcps: old.factory === 'engineer' ? engineerExtraMcps : [],
          deps: makeSpawnDeps(old.factory),
          taskWorktree: resolveSpawnWorktreePath(),
          seatId: old.seat_id,
        }),
    )

    db.prepare(
      `INSERT OR IGNORE INTO agents
       (id, task_id, seat_id, factory, display_name, state, factory_version, model_profile, spawned_at)
       VALUES (?, ?, ?, ?, ?, 'idle', ?, ?, ?)`,
    ).run(
      spawnResult.agentId,
      taskId,
      old.seat_id,
      old.factory,
      spawnResult.displayName,
      factory.version,
      spawnResult.modelProfile ? JSON.stringify(spawnResult.modelProfile) : null,
      new Date().toISOString(),
    )

    agentSessions.set(spawnResult.agentId, spawnResult.sessionId)
    seatToAgent.set(old.seat_id, spawnResult.agentId)
    if (old.factory === 'planner') plannerAgentId = spawnResult.agentId

    spawningSeats.delete(old.seat_id)
    publishPresence(old.seat_id, spawnResult.agentId, spawnResult.displayName)
    const replacementPrompt = buildModelFallbackPrompt(
      factory,
      spawnResult.displayName,
      old.display_name,
      error,
    )
    startAgentWork({
      agentId: spawnResult.agentId,
      sessionId: spawnResult.sessionId,
      seatId: old.seat_id,
      displayName: spawnResult.displayName,
      factoryName: old.factory,
      prompt: replacementPrompt,
      intro: `我已切换模型接管，身份是 ${spawnResult.displayName}（${old.factory}）。我会先同步上下文，然后继续当前阶段工作。`,
    })
  } catch (err) {
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err)
    log.error({ agentId, errDetail: detail }, 'model fallback failed')
    const seatId = seatIdByAgent(agentId)
    if (seatId) {
      spawningSeats.delete(seatId)
      publishPresence(seatId, null, null)
    }
    writeChatroomMsg('system', 'main', 'system-event', `模型 fallback 失败：${detail}`)
    process.send?.({
      type: 'task-event',
      subtype: 'notification',
      taskId,
      level: 'error',
      content: `模型 fallback 失败：${detail}`,
    } satisfies TaskEvent)
  } finally {
    fallbackInProgressAgents.delete(agentId)
  }
}

/** 系统驱动的状态转移（如 S2→S6 all-idle 自动推进）。校验当前态 + 写 state_history + 触发副作用。*/
function advanceState(from: TaskState, to: TaskState, by: string): void {
  const row = db.prepare('SELECT state FROM tasks_meta WHERE id = ?').get(taskId) as
    | { state: string }
    | undefined
  if (row?.state !== from) {
    log.warn({ current: row?.state, from, to }, 'advanceState 跳过 — 当前态不匹配')
    return
  }
  const transition = findTransition(from, to)
  if (!transition) {
    log.error({ from, to }, 'advanceState — 无对应 transition')
    return
  }
  const at = new Date().toISOString()
  const vRow = db
    .prepare('SELECT MAX(version) as v FROM state_history WHERE task_id = ?')
    .get(taskId) as { v: number | null }
  db.prepare(
    `INSERT INTO state_history (task_id, from_state, to_state, event, by, version, at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(taskId, from, to, transition.event, by, (vRow.v ?? 0) + 1, at)
  db.prepare('UPDATE tasks_meta SET state = ? WHERE id = ?').run(to, taskId)
  applyTransitionEffects(taskId, from, to, by, emitter, [])
  log.info({ from, to, by }, 'state advanced (system)')
}

/** sessionId → agentId 反查（agentSessions 是 agentId→sessionId）*/
function agentIdBySession(sessionId: string): string | null {
  for (const [aid, sid] of agentSessions) if (sid === sessionId) return aid
  return null
}

/** 往 chatroom 写一条消息 + 广播给前端（供 agent 流式可见性用）*/
function writeChatroomMsg(sender: string, channel: string, type: string, content: string): void {
  const now = new Date().toISOString()
  const msgId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  const urgentKey =
    type === 'system-event' && isUrgentSystemEvent(content) ? urgentKeyForContent(content) : null
  db.prepare(
    `INSERT INTO chatroom_messages
     (id, task_id, channel, type, sender, content, mention, refs, reply_to, urgent_key, acknowledged_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, '[]', '[]', NULL, ?, NULL, ?)`,
  ).run(msgId, taskId, channel, type, sender, content, urgentKey, now)
  emitter.emit('chatroom-msg', {
    taskId,
    message: {
      id: msgId,
      taskId,
      channel,
      type,
      sender,
      content,
      mention: [],
      refs: [],
      replyTo: null,
      urgentKey,
      acknowledgedAt: null,
      createdAt: now,
    },
  })
}

// (promptQaForVerificationReport 已删 — phase-driven 下 S10' 不再是 qa driver 阶段:
//  qa 在 S7 就已写完 verification_report 并 propose;S10' 仅 notify-human 等人类点完成。)

// 每个 agent 一个文本累积器（流式 chunk → 完整消息，turn 结束 flush）
const textAccumulators = new Map<string, TextAccumulator>()

// 本 turn 是否调用过 chatroom_send(per agent)— done 时区分 stream 是真"思考流"还是"唯一回应"。
// turn done 后清空。Map<agentId, true>
const chatroomSendThisTurnByAgent = new Map<string, boolean>()

function attachRuntimeAdapterListeners(adapter: CliAdapter): void {
  adapter.on(
    'exit',
    (evt: { sessionId: string; code: number | null; signal: string | null }) => {
      log.warn({ provider: adapter.provider, ...evt }, 'agent bridge exited — crash recovery not yet implemented')
    },
  )

  // agent 原始事件可见性：日志（provider-specific 原始 update 只做诊断，不再在 task-process 里解析）
  adapter.on('update', (evt: { sessionId: string; update: Record<string, unknown> }) => {
    const agentId = agentIdBySession(evt.sessionId) ?? evt.sessionId
    log.info(
      {
        agentId,
        provider: adapter.provider,
        kind: evt.update?.['sessionUpdate'] ?? evt.update?.['type'],
      },
      'agent update',
    )
  })

  adapter.on('text', (evt: RuntimeTextEvent) => {
    if (probingSessions.has(evt.sessionId)) return
    const agentId = agentIdBySession(evt.sessionId) ?? evt.sessionId
    const seatId = seatIdByAgent(agentId)
    markAgentWorking(agentId, seatId)
    let acc = textAccumulators.get(agentId)
    if (!acc) {
      acc = new TextAccumulator()
      textAccumulators.set(agentId, acc)
    }
    acc.append(evt.text)
    // 流式 delta:推给主 server WS 广播,前端组装草稿气泡;
    // 不落 DB,turn 结束 done 时正式 writeChatroomMsg 一并落表(可能分类为
    // agent-text 或 agent-thinking,见 done handler 的分类逻辑)。
    process.send?.({
      type: 'task-event',
      subtype: 'chatroom-msg-delta',
      taskId,
      agentId,
      channel: 'main',
      content: acc.current,
    } satisfies TaskEvent)
  })

  adapter.on('tool', (evt: RuntimeToolEvent) => {
    if (probingSessions.has(evt.sessionId)) return
    const agentId = agentIdBySession(evt.sessionId) ?? evt.sessionId
    const seatId = seatIdByAgent(agentId)
    markAgentWorking(agentId, seatId)
    const inputStr = (() => {
      try {
        return JSON.stringify(evt.rawInput).slice(0, 300)
      } catch {
        return ''
      }
    })()
    writeChatroomMsg(agentId, 'tool-traces', 'tool-trace', `🔧 ${evt.title} ${inputStr}`)
    // 标记本 turn 已经显式调用 chatroom_send(用于 done 时区分 thinking vs text)。
    // claude-acp 工具名形如 mcp__chatroom__chatroom_send;codex-sdk 形如 chatroom.chatroom_send。
    if (evt.title.includes('chatroom_send')) {
      chatroomSendThisTurnByAgent.set(agentId, true)
    }
    // 防静默:tool 活动 = 进展;propose 单独标记(idle hook 判生产力用)
    markProgress('tool')
    if (evt.title.includes('task_state_propose')) {
      proposedThisTurnByAgent.add(agentId)
    }
  })

  // turn 结束:flush 累积的 agent stream text 到 chatroom main 频道。
  // 分类规则(agent-presence-ui 设计延伸):
  // - 本 turn 调用过 chatroom_send → stream 是真的"思考流",分 agent-thinking,前端折叠
  // - 本 turn 未调 chatroom_send → stream 就是 agent 唯一对外回应,分 agent-text 正常展示
  // 解决 codex-sdk 等模型不爱调 chatroom_send 而直接 stream 完整回复时被折叠到思考的体感问题。
  adapter.on('done', (evt: RuntimeDoneEvent) => {
    if (probingSessions.has(evt.sessionId)) return
    const agentId = agentIdBySession(evt.sessionId) ?? evt.sessionId
    log.info({ agentId, provider: adapter.provider, stopReason: evt.stopReason }, 'agent turn done')
    persistRuntimeUsage(agentId, adapter.provider, evt)
    const acc = textAccumulators.get(agentId)
    if (acc && !acc.isEmpty) {
      const sentExplicit = chatroomSendThisTurnByAgent.get(agentId) ?? false
      const type: 'agent-text' | 'agent-thinking' = sentExplicit ? 'agent-thinking' : 'agent-text'
      writeChatroomMsg(agentId, 'main', type, acc.flush())
    }
    const seatId = seatIdByAgent(agentId)
    markAgentIdle(agentId, seatId)
    // 防静默 idle-entry hook:判本 turn 是否空转(用 turn 内累积的标记),再清状态
    checkIdleProductivity(agentId, seatId)
    chatroomSendThisTurnByAgent.delete(agentId)
    proposedThisTurnByAgent.delete(agentId)
    turnStartAtByAgent.delete(agentId)
  })

  adapter.on('runtime-error', (evt: RuntimeErrorEvent) => {
    if (evt.sessionId && probingSessions.has(evt.sessionId)) {
      log.warn(
        { provider: evt.provider, reason: evt.reason, raw: evt.raw },
        'model profile probe runtime error',
      )
      return
    }
    const agentId = evt.sessionId
      ? (agentIdBySession(evt.sessionId) ?? evt.sessionId)
      : 'unknown-agent'
    log.error(
      { agentId, provider: evt.provider, reason: evt.reason, raw: evt.raw },
      'agent runtime error',
    )
    if (evt.reason === 'quota' && evt.sessionId) {
      const mappedAgentId = agentIdBySession(evt.sessionId)
      if (mappedAgentId) {
        switchAgentModelProfile(mappedAgentId, evt).catch((err) => {
          log.error({ err, mappedAgentId }, 'async model fallback failed')
        })
        return
      }
    }
    process.send?.({
      type: 'task-event',
      subtype: 'notification',
      taskId,
      level: 'error',
      content: `agent runtime error (${evt.provider}/${evt.reason}, agent=${agentId}): ${evt.message}`,
    } satisfies TaskEvent)
  })
}

function persistRuntimeUsage(agentId: string, provider: RuntimeProvider, evt: RuntimeDoneEvent): void {
  persistRuntimeDoneUsage({
    db,
    taskId,
    projectId,
    agentId,
    provider,
    event: evt,
  })
}

function seatIdByAgent(agentId: string): string | null {
  const row = db.prepare('SELECT seat_id FROM agents WHERE id = ?').get(agentId) as
    | { seat_id: string }
    | undefined
  return row?.seat_id ?? null
}

function markAgentWorking(agentId: string, seatId: string | null): void {
  db.prepare("UPDATE agents SET state = 'working' WHERE id = ?").run(agentId)
  turnRunningAgents.add(agentId)
  // 防静默:记 turn 起始(首次进 working 时),供 idle hook 判 deliverable 是否本 turn 更新
  if (!turnStartAtByAgent.has(agentId)) turnStartAtByAgent.set(agentId, Date.now())
  if (!seatId) return
  publishPresence(seatId, agentId, null)
}

function markAgentIdle(agentId: string, seatId: string | null): void {
  db.prepare("UPDATE agents SET state = 'idle' WHERE id = ?").run(agentId)
  turnRunningAgents.delete(agentId)
  if (!seatId) return
  publishPresence(seatId, agentId, null)
}

function startAgentWork(opts: {
  agentId: string
  sessionId: string
  seatId: string
  displayName: string
  factoryName: string
  prompt: string
  intro: string
}): void {
  writeChatroomMsg(opts.agentId, 'main', 'agent-text', opts.intro)
  markAgentWorking(opts.agentId, opts.seatId)
  promptSession(opts.sessionId, opts.prompt).catch((err: unknown) => {
    if (fallbackInProgressAgents.has(opts.agentId)) return
    const detail = errorDetail(err)
    log.error(
      { agentId: opts.agentId, seatId: opts.seatId, err },
      'failed to send initial prompt to agent',
    )
    markAgentIdle(opts.agentId, opts.seatId)
    writeChatroomMsg(
      'system',
      'main',
      'system-event',
      `${opts.displayName}（${opts.factoryName}）启动失败：未能发送首轮任务信息。${detail}`,
    )
    process.send?.({
      type: 'task-event',
      subtype: 'notification',
      taskId,
      level: 'error',
      content: `${opts.displayName}（${opts.factoryName}）启动失败：${detail}`,
    } satisfies TaskEvent)
  })
}

// 4. 监听主 server IPC 消息
process.on('message', (raw: unknown) => {
  const msg = parseIpcMessage(raw)
  if (!msg) {
    log.warn({ raw }, 'task-process: unknown IPC message')
    return
  }

  switch (msg.type) {
    case 'heartbeat': {
      if (msg.direction === 'ping') {
        process.send?.({ type: 'heartbeat', direction: 'pong', at: new Date().toISOString() })
      }
      break
    }

    case 'user-input': {
      handleUserInput(msg as UserInput)
      break
    }

    case 'lifecycle-control': {
      if (msg.action === 'shutdown') {
        log.info('task-process: shutdown requested')
        shutdown()
      } else if (msg.action === 'pause-all') {
        for (const sid of agentSessions.values()) pauseSession(sid)
      } else if (msg.action === 'resume-all') {
        for (const sid of agentSessions.values()) resumeSession(sid)
      }
      break
    }

    default:
      break
  }
})

/**
 * 处理来自主 server 的用户输入。
 * human-message → 写 chatroom DB + 通过 ACP prompt 发给 planner。
 */
function handleUserInput(msg: UserInput): void {
  if (msg.subtype === 'message') {
    log.info(
      { channel: msg.channel, contentLen: msg.content.length },
      'human message received → writing to chatroom + prompting planner',
    )

    // 人类发消息 = 解除急停(humanPaused),后续唤醒恢复正常
    if (humanPaused) {
      humanPaused = false
      for (const sid of agentSessions.values()) resumeSession(sid)
      log.info({ taskId }, 'human message → auto-resume from pause')
    }
    clearHumanConfirmationPending('human-message')

    const now = new Date().toISOString()
    const msgId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const mentionedSeatIds: string[] = msg.mention ?? []

    // 写 chatroom DB
    db.prepare(
      `INSERT INTO chatroom_messages
       (id, task_id, channel, type, sender, content, mention, refs, reply_to, created_at)
       VALUES (?, ?, ?, 'human-msg', 'human', ?, ?, ?, NULL, ?)`,
    ).run(
      msgId,
      taskId,
      msg.channel,
      msg.content,
      JSON.stringify(mentionedSeatIds),
      JSON.stringify(msg.refs ?? []),
      now,
    )

    // 广播给前端
    emitter.emit('chatroom-msg', {
      taskId,
      message: {
        id: msgId,
        taskId,
        channel: msg.channel,
        type: 'human-msg',
        sender: 'human',
        content: msg.content,
        mention: mentionedSeatIds,
        refs: msg.refs ?? [],
        replyTo: null,
        createdAt: now,
      },
    })

    // 路由消息到对应 agent session：mention 优先走统一 wake 原语,避免 task-process
    // 重启后 seatToAgent/agentSessions 内存丢失导致 @ engineer 静默掉。
    if (mentionedSeatIds.length > 0) {
      for (const seatId of mentionedSeatIds) {
        const prompt = [
          '人类在 chatroom @ 你:',
          msg.content,
          '',
          '请按这条人类指令继续处理。若这是 QA FAIL/回修/等待下一轮产物,必须继续实现、测试、commit 并产出新一轮 eng 交付;不要只回复确认后停下。',
        ].join('\n')
        wake(seatId, prompt).catch((err: unknown) => {
          log.error({ seatId, err }, 'failed to wake mentioned seat with human message')
        })
      }
      return
    }

    // 若无 mention 路由目标，默认发 planner
    if (plannerAgentId) {
      const sid = agentSessions.get(plannerAgentId)
      if (sid) {
        promptSession(sid, msg.content).catch((err: Error) => {
          log.error({ targetAgentId: plannerAgentId, err }, 'failed to prompt planner with human message')
        })
      } else {
        log.warn({ targetAgentId: plannerAgentId }, 'planner session not found — message dropped')
      }
    } else {
      log.warn('no agent available to receive human message — dropped')
    }
  } else if (msg.subtype === 'control') {
    log.info({ action: msg.action }, 'control received')
    if (msg.action === 'pause') {
      // 人类急停(ESC ESC):打断所有在跑 turn(codex abort 当前 prompt / acp SIGSTOP)
      // + 置 humanPaused 门控后续唤醒。agents 转 idle 等人类下一步。
      humanPaused = true
      for (const sid of agentSessions.values()) interruptSession(sid)
      writeChatroomMsg(
        'system',
        'main',
        'system-event',
        '⏸ 已停止所有 agent 工作(人类急停)。发消息或点恢复以继续。',
      )
      log.info({ taskId }, 'human pause: interrupted all sessions')
    } else if (msg.action === 'resume') {
      clearHumanConfirmationPending('human-resume')
      humanPaused = false
      for (const sid of agentSessions.values()) resumeSession(sid)
      // 重新唤醒当前阶段 driver,让被打断的工作继续
      wakeDriversForPhase(currentTaskState() as TaskState)
      log.info({ taskId }, 'human resume → re-woke phase drivers')
    } else if (msg.action === 'abort') {
      clearHumanConfirmationPending('human-abort')
      db.prepare('UPDATE tasks_meta SET state = ? WHERE id = ?').run('aborted', taskId)
      emitter.emitRelease({ taskId, reason: 'aborted' })
    } else if (msg.action === 'complete') {
      clearHumanConfirmationPending('human-complete')
      resumeFromHumanPause('complete')
      // 人类点"完成"：S10' → S11，进入复盘
      const row = db.prepare('SELECT state FROM tasks_meta WHERE id = ?').get(taskId) as
        | { state: string }
        | undefined
      if (row?.state !== "S10'") {
        log.warn({ state: row?.state }, "complete 忽略 — 任务不在 S10'")
        return
      }
      const transition = findTransition("S10'", 'S11')
      if (!transition) {
        log.error("无 S10'→S11 transition")
        return
      }
      const at = new Date().toISOString()
      const vRow = db
        .prepare('SELECT MAX(version) as v FROM state_history WHERE task_id = ?')
        .get(taskId) as { v: number | null }
      db.prepare(
        `INSERT INTO state_history (task_id, from_state, to_state, event, by, version, at)
         VALUES (?, ?, ?, ?, 'human', ?, ?)`,
      ).run(taskId, "S10'", 'S11', transition.event, (vRow.v ?? 0) + 1, at)
      db.prepare('UPDATE tasks_meta SET state = ? WHERE id = ?').run('S11', taskId)
      applyTransitionEffects(taskId, "S10'", 'S11', 'human', emitter, [])
      // planner 的 retro prompt 由 retro-start 事件统一处理（见下方 emitter.on('retro-start', ...)）
    } else if (msg.action === 'done') {
      clearHumanConfirmationPending('human-done')
      resumeFromHumanPause('done')
      // task-bootstrap-lifecycle phase 5.1: 用户点 done 进入 releasing(收尾编排)。
      // agents 保持在线;planner 产出 retrospective + archive-plan 后才 propose done,
      // 校验通过(含 bootstrap resources 终态)后再释放。
      const cur = db.prepare('SELECT state FROM tasks_meta WHERE id = ?').get(taskId) as
        | { state: string }
        | undefined
      const fromState = (cur?.state ?? 'unknown') as TaskState
      if (fromState === 'releasing') {
        writeChatroomMsg(
          'system',
          'main',
          'system-event',
          '人类再次请求收尾,已重新唤醒 planner 继续 releasing 收尾。',
        )
        wakeDriversForPhase('releasing')
        return
      }
      if (fromState === 'done' || fromState === 'aborted') {
        log.info({ fromState }, "done 忽略 — 任务已在 releasing/done/aborted")
        return
      }
      const at = new Date().toISOString()
      const vRow = db
        .prepare('SELECT MAX(version) as v FROM state_history WHERE task_id = ?')
        .get(taskId) as { v: number | null }
      try {
        db.prepare(
          `INSERT INTO state_history (task_id, from_state, to_state, event, by, version, at)
           VALUES (?, ?, 'releasing', 'human-done', 'human', ?, ?)`,
        ).run(taskId, fromState, (vRow.v ?? 0) + 1, at)
      } catch (err) {
        log.warn({ err }, 'state_history insert failed (non-fatal)')
      }
      db.prepare('UPDATE tasks_meta SET state = ? WHERE id = ?').run('releasing', taskId)
      writeChatroomMsg(
        'system',
        'main',
        'system-event',
        '用户已确认完成,进入 releasing 收尾阶段。planner 将产出 retrospective + archive-plan,agents 暂不释放。',
      )
      applyTransitionEffects(taskId, fromState, 'releasing', 'human', emitter, [])
    }
  }
}

/**
 * 创建 SpawnDeps，在 spawnCli 中以 factoryName 注册 agent 到 HTTP MCP server。
 * 复用于 planner 和 engineer spawn。
 */
function makeSpawnDeps(factoryName: string): SpawnDeps {
  return {
    async initWorkspace(opts) {
      return initAgentWorkspace(opts)
    },
    async probeSymlinks(workspacePath, skills) {
      return probeSymlinks(workspacePath, skills)
    },
    fallbackCopySkills(workspacePath, skills, globalSkillsDir) {
      fallbackCopySkills(workspacePath, skills, globalSkillsDir, log)
    },
    async spawnCli(opts) {
      // 从 workspace path 末段提取 agentId
      const agentId = path.basename(opts.workspace)

      // 注册到 HTTP MCP server（创建专属 transport）
      mcpCtx.registerAgent(agentId, factoryName)

      // 组装最终 mcpServers：将 chatroom/chatroom-mcp stdio 替换为 http 形态
      const chatroomMcp: MiniMcpServer = {
        type: 'http',
        name: 'chatroom',
        url: mcpCtx.getMcpUrl(agentId),
        headers: [],
      }
      const filteredMcps = opts.mcpServers.filter(
        (s) => s.name !== 'chatroom' && s.name !== 'chatroom-mcp',
      )
      const finalMcps: MiniMcpServer[] = [chatroomMcp, ...filteredMcps]

      // 用正确的 HTTP chatroom URL 覆盖写 mcp.json + settings.json
      const mcpServersObj: Record<string, unknown> = {}
      for (const s of finalMcps) {
        if (s.type === 'http') {
          mcpServersObj[s.name] = { type: 'http', url: s.url }
        } else if (s.type === 'sse') {
          mcpServersObj[s.name] = { type: 'sse', url: s.url }
        } else {
          // stdio 形态
          const stdioServer = s as { command: string; args: string[]; env?: Record<string, string> }
          const entry: Record<string, unknown> = {
            command: stdioServer.command,
            args: stdioServer.args,
          }
          if (stdioServer.env) entry['env'] = stdioServer.env
          mcpServersObj[s.name] = entry
        }
      }

      fs.writeFileSync(
        path.join(opts.workspace, 'mcp.json'),
        JSON.stringify({ mcpServers: mcpServersObj }, null, 2),
        'utf-8',
      )
      fs.writeFileSync(
        path.join(opts.workspace, '.claude', 'settings.json'),
        JSON.stringify(
          createAgentSettings({
            agentId,
            taskId,
            mcpServers: mcpServersObj,
            token: process.env.AGENT_TEAM_TOKEN,
            port: process.env.PORT,
          }),
          null,
          2,
        ),
        'utf-8',
      )

      const factory = getFactory(factoryName)
      const modelProfile = opts.runtime ?? (factory ? resolveAgentModelProfile(factory) : undefined)
      const adapter = getRuntimeAdapter(modelProfile)
      const runtimeEnv =
        modelProfile?.provider === 'claude-acp'
          ? buildClaudeTelemetryEnv(agentId, factoryName, mcpCtx.getOtelUrl(agentId))
          : undefined
      const sessionId = await adapter.spawn({
        workspace: opts.workspace,
        additionalDirectories: opts.additionalDirectories,
        mcpServers: finalMcps,
        initialPrompt: '',
        runtime: modelProfile,
        env: runtimeEnv,
      })
      sessionAdapters.set(sessionId, adapter)
      return sessionId
    },
  }
}

/**
 * 从 DB 查询 seat 信息，加载 engineer 工厂，spawn engineer 并写 DB。
 * 复用 planner spawn 范式。
 */
async function spawnEngineerForSeat(seatId: string): Promise<void> {
  // 查 seat 信息
  const seatRow = db.prepare('SELECT * FROM seats WHERE id = ?').get(seatId) as
    | { id: string; task_id: string; role: string; factory: string; model_override?: string | null }
    | undefined
  if (!seatRow) {
    log.error({ seatId }, 'seat not found in DB — cannot spawn engineer')
    return
  }

  const factoryName = seatRow.factory
  const engineerFactory = getFactory(factoryName)
  if (!engineerFactory) {
    log.error({ factoryName }, 'engineer factory not found — cannot spawn')
    return
  }

  // Phase 4.3: code-worktree-dependent factories MUST wait for primary worktree ready.
  // creating → poll/wait with bounded timeout; failed → surface error + abort spawn;
  // ready or absent (provider=none) → proceed.
  const needsWorktree = factoryName === 'engineer' || factoryName === 'qa' || factoryName === 'ci'
  if (needsWorktree) {
    const gate = await awaitWorktreeReadyGate(seatId, factoryName)
    if (!gate.ok) {
      publishPresence(seatId, null, null)
      return
    }
  }

  // 读 agent.md
  const agentMdPath = path.join(__dirname, '../../../../agent.md')
  let agentMdContent = ''
  if (fs.existsSync(agentMdPath)) {
    agentMdContent = fs.readFileSync(agentMdPath, 'utf-8')
  }

  // 渲染 engineer initialPrompt
  const systemPromptBase = renderSystemPromptBase(engineerFactory, taskTitle, agentMdContent)

  // Phase 4.1/4.2: worktree path derived from primary-worktree resource.
  // gate 已保证(needsWorktree && resource 存在)时 status=ready;若 provider=none(resource 缺失),
  // 仍记一个占位字符串以便 prompt 渲染,但 prompt 中显式说明 NOT ready。
  const worktreeResourceRow = readPrimaryWorktreeResource()
  const worktreeReady =
    worktreeResourceRow != null &&
    worktreeResourceRow.status === 'ready' &&
    !!worktreeResourceRow.path
  const wt =
    worktreeReady && worktreeResourceRow?.path
      ? worktreeResourceRow.path
      : path.join(taskWorkdir, 'worktree')
  const wtBranch = worktreeResourceRow?.branch ?? null
  const wtProvider = worktreeResourceRow?.provider ?? 'none'
  const wtMode = worktreeResourceRow?.mode ?? 'default'
  const workspaceInfoBlock = worktreeReady
    ? [
        '## 你的代码工作区(由 bootstrap 提供)',
        `- **worktree 绝对路径**：\`${wt}\``,
        wtBranch ? `- **分支**：\`${wtBranch}\`` : '- **分支**：(未记录)',
        `- **provider/mode**：\`${wtProvider}\`/\`${wtMode}\``,
        '在该路径下做改动、跑命令、`git commit`。**不要去任务管理目录下改源码**。',
      ].join('\n')
    : [
        '## 你的代码工作区',
        `- **worktree NOT ready** — 请勿在空目录工作。当前 bootstrap 状态:\`${
          worktreeResourceRow?.status ?? 'none/缺失'
        }\` (provider=\`${wtProvider}\`${
          worktreeResourceRow?.error ? `, error=${worktreeResourceRow.error}` : ''
        }).`,
        '调用 `task_resource_get` 复查 primary-worktree;未 ready 前不要 `git`/源码改动,在 chatroom 报告阻塞。',
      ].join('\n')

  const engineerPrompt = [
    systemPromptBase,
    '',
    '---',
    workspaceInfoBlock,
    '',
    '---',
    '## 入场指示（S6 实现阶段 — 必须完整执行）',
    '',
    '你已被招募进入 S6 实现阶段。请按以下顺序执行，**每步都必须真实完成，不得跳过或只分析**：',
    '',
    '1. **同步上下文**：调用 `chatroom_recent` 拉取 main 频道最近 50 条消息，了解任务背景',
    '2. **读取分工**：调用 `artifact_list` 列出已注册制品，找到 task-plan.md 读取你的具体工作范围',
    `3. **实现代码（必须）**：在上述 worktree(\`${wt}\`) 中做出**真实的代码改动**（即使是最小可行修复），`,
    '   - 每个子任务完成后立即执行：`git add <改动文件>` + `git commit -m "<说明改动>"`',
    '   - **必须有 git commit 才算完成实现**，只分析不改代码不可接受',
    '   - **绝对禁止绕过提交门禁**：不得使用 `git commit --no-verify` / `HUSKY=0` / `SKIP_*` 等跳过 pre-commit、lint、typecheck、test hook。hook 失败先修；若确认是环境/依赖缺失,必须在 chatroom 报告失败命令、错误摘要、已尝试修复和建议处理,等待人类明确允许后才可继续。无人类确认时不得 commit、不得 propose。',
    '   - **QA FAIL 回修必须继续实现**：如果 main 频道或 `qa/verification_report*.md` 已给出 FAIL/回修项,不要只回复确认。必须修复失败项、补回归测试、产生新 commit,并写新一轮 `eng/test-report-<n>.md` / `eng/commits-<n>.txt` 后再交回 QA。',
    '   - **命令约束**：不要前台运行 `dev`/`watch`/`preview` 等长驻服务；需要时必须用 `timeout` 或后台启动并记录 PID 后清理。不要为验收临时安装大型依赖。',
    '4. **写测试报告（必须）**：通过 `task_write` 写入 `eng/test-report.md`，内容必须包含：',
    '   - `# Test Report` 标题',
    '   - `## 改动说明` —— 列出修改了哪些文件、改了什么',
    '   - `## 结果` —— 测试执行结果（通过/失败），若无法运行测试则说明原因',
    '5. **propose 推进（必须）**：先查 chatroom 看本任务是否有 **qa seat**。',
    '   - **有 qa seat** → `task_state_propose(taskId, "S7", { artifacts: ["eng/test-report.md"] })` 进 qa 验收。',
    "   - **无 qa seat** → `task_state_propose(taskId, \"S10'\", { artifacts: [\"eng/test-report.md\"] })`(M1 直通兼容路径)。",
    '',
    '**重要**：第 3-5 步是交付标准的一部分，任何一步缺失都视为未完成。',
    '不要停留在分析阶段——即使代码改动很小，也必须做出真实改动并 commit。',
  ].join('\n')

  const qaPrompt = [
    systemPromptBase,
    '',
    '---',
    workspaceInfoBlock,
    '',
    '---',
    '## 入场指示（发现式验收 — 与 engineer 同源从规约 fork，自主核实，不动代码）',
    '',
    '你已被招募做验收。**你和 engineer 同源**从规约(task-plan 锚点 / specs Scenario / acceptance)派生工作，**不是** engineer 下游审核员。engineer 的 eng/test-report.md **仅作白盒参考**，不能替代你自己运行时跑出的证据；**不要**因为 engineer 没出 report 就停下来等。',
    '',
    '1. **同步上下文**：`chatroom_recent` 拉 main 最近 50 条 + `artifact_list`/`artifact_get` 读 task-plan 的「验收锚点」(可选再扫 eng/test-report.md 作参考)。',
    '2. **发现式验证（核心）**：你有完整 bash + 文件工具 + 全局 CLI `agent-browser`。对每条验收锚点**自主**跑证据，核实「实际 vs 预期」自主发现偏差。',
    "   - **轨道 A 功能 e2e**(UI 行为必跑)：用 `agent-browser open/snapshot/click/fill/screenshot` 实际驱动浏览器走「用户会做的事」，截图 + snapshot 文本作为硬证据。需要底层浏览器命令或验收工作流时读 `agent-browser` / `playwright-cli` skill。",
    '   - **轨道 B 视觉/交互**：读 `plan/visual-contract.md`(planner 兼任 pm-ux 出 / 未来真 pm-ux 出)对照截图核验布局/可访问性树。若无 visual-contract 制品,只跑轨道 A。',
    '   - **后端/数据/CLI 行为**：起服务 / `curl` 接口 / 查 SQLite / 跑测试。**worktree 路径见 chatroom 里 planner 给的绝对路径**。',
    '   - **命令约束**：不要前台运行 `dev`/`watch`/`preview` 等长驻服务(前后端通常已被 harness 起好；自己起须 `timeout` 或后台 + PID 清理)。不要为验收临时安装大型依赖。',
    '3. **报告（必须，增量写）**：**每验完一条立即** `task_write(taskId, "qa/verification_report.md", { content, overwrite: true })` 把已验的 N 条整体重写一遍 —— 防止超时丢报告。每锚点格式：',
    '   - `## <锚点>` + `结论: PASS/FAIL` + `证据:`(命令+输出/截图绝对路径)',
    '   - FAIL 时必须三段：`现象:` 实际 UI/接口表现 + 截图 + snapshot 节选; `根因:` 推断的文件:行 + 现象(不确定写"待 engineer 确认"，不乱猜); `修复方案:` 具体动作(改哪个 handler / 加什么字段)',
    '   - 末尾给 `## 最终结论: PASS|FAIL`',
    '4. **闭环 + propose**(只在 S7 时)：全 PASS → 先看本任务是否有 ci seat(`chatroom_recent` / `seat_list`):',
    "   - **有 ci seat** → `task_state_propose(taskId, \"S9\", { artifacts: [\"qa/verification_report.md\"] })` 进 ci 监控阶段",
    "   - **无 ci seat** → `task_state_propose(taskId, \"S10'\", { artifacts: [\"qa/verification_report.md\"] })`(M2 兼容)",
    "   - **任一 FAIL** → **不要 propose 推进**(L2b/L2c 校验会拒);先 `chatroom_send` `mention` engineer 列**具体**修复项(贴 现象/根因/修复方案)，等其修完后**只复验该项**;若 engineer 长时间无响应，再 `task_state_propose(taskId, \"S6\", { artifacts: [\"qa/verification_report.md\"] })` 显式回 repair 阶段。",
    '   - **qa 全程不动代码** —— repair 是 engineer 的活。',
    '',
    "**收口规则**：一旦 `task_state_get` 显示进入 `S7` 或 `S10'`，不要继续扩展探索范围；用已收集证据立即收口报告。证据不足/engineer 未响应/工具失败/实现不满足锚点 → 也必须写 FAIL 报告 + 阻塞点。",
    '**预算**：截图 ≤ 12 张/任务 · agent-browser 命令 ≤ 20 条 · 读源码 ≤ 8 个文件(仅定位 FAIL 根因时读)。',
    '**重要**：能跑的验证必须亲自跑，用命令/截图证据。声称"验收通过/PASS"前必须在本条消息内贴出刚跑出的命令输出，没有新鲜证据不许下 PASS。',
  ].join('\n')

  // openspec 文档驱动模式（env 门控）：engineer 按 change 的 tasks.md 实现；qa 按 specs Scenario 逐条验收 + archive
  const useOpenspec = process.env['AGENT_TEAM_OPENSPEC'] === '1'
  const planningHome = taskWorkdir

  const engineerOpenspecPrompt = [
    systemPromptBase,
    '',
    '---',
    workspaceInfoBlock,
    '',
    '---',
    '## 入场指示（openspec 实现 — 按 change 的 tasks.md 逐条落地）',
    '',
    `本任务用 openspec 文档驱动。计划是一个 openspec change。planning home = 任务根 \`${planningHome}\`（openspec 文档在此，与代码 worktree \`${wt}\` 分开）。`,
    '',
    '1. **同步**：`chatroom_recent` 拉 main 最近 50 条。',
    `2. **读 change**：\`cd ${planningHome}\` → \`openspec list\` 找 change 名 → 用 \`openspec-apply-change\` skill（\`openspec status --change <name> --json\`）读 proposal/design/specs/tasks.md。**specs/ 里的 Scenario 是你实现要满足的验收标准**。`,
    `3. **逐条实现（必须）**：在 worktree \`${wt}\` 按 tasks.md 实现。每完成一条就把 tasks.md 里对应 \`- [ ]\` 改成 \`- [x]\`（文件在 \`${planningHome}/openspec/changes/<name>/tasks.md\`），并 \`git commit\`。`,
    '   - **命令约束**：不要前台运行 `dev`/`watch`/`preview` 等长驻服务；如需启动服务，使用 `timeout 30s ...` 或后台启动、记录 PID、验证后清理。',
    '   - **依赖约束**：磁盘紧张，不要现场 `pnpm add` / `pnpm install` 大型依赖；若缺少浏览器自动化包，用源码布局检查 + `pnpm --filter @agent-team/web build`/`typecheck` 作为轻量证据。',
    '4. **写测试报告（必须）**：`task_write(taskId, "eng/test-report.md", ...)`，含 `# Test Report` + `## 改动说明` + `## 结果`。',
    "5. **propose（必须）**：有 qa seat → `task_state_propose(taskId, \"S7\", { artifacts: [\"eng/test-report.md\"] })` 进 qa 验收；无则 `task_state_propose(taskId, \"S10'\", ...)`(兼容)。",
    '',
    '**重要**：tasks 复选框要真勾、代码要真 commit、实现要满足 specs 的每个 Scenario。',
  ].join('\n')

  const qaOpenspecPrompt = [
    systemPromptBase,
    '',
    '---',
    workspaceInfoBlock,
    '',
    '---',
    '## 入场指示（openspec 发现式验收 — 对 specs 每个 Scenario 自主核实，不许空报告）',
    '',
    `本任务用 openspec 文档驱动。**验收标准 = change 的 specs/ 下每个 Scenario(WHEN/THEN)**。planning home = \`${planningHome}\`，代码 worktree = \`${wt}\`。**你与 engineer 同源**从 specs Scenario 派生工作，engineer 的 test-report 仅作白盒参考；不要等 engineer。`,
    '',
    `1. **同步 + 找 change**：\`chatroom_recent\` 拉 main；\`cd ${planningHome}\` → \`openspec list\` 拿 change 名。`,
    `2. **读验收锚点**：读 \`${planningHome}/openspec/changes/<name>/specs/**/spec.md\` 里**所有 Scenario**(可选再扫 eng/test-report.md + \`git -C ${wt} log\` 当白盒参考)。`,
    '3. **发现式逐条验证（核心）**：对**每一个 Scenario** 自主跑证据，核实「实际 vs 预期」。',
    "   - **轨道 A 功能 e2e**(UI Scenario 必跑)：用全局 CLI `agent-browser`(open/snapshot/click/fill/screenshot) 实际驱动浏览器；需要底层浏览器命令或验收工作流时读 `agent-browser` / `playwright-cli` skill。截图 + snapshot 文本作为硬证据。",
    '   - **轨道 B 视觉/交互**：读 `plan/visual-contract.md`(planner 兼任 pm-ux 出 / 未来真 pm-ux 出)对照截图核验。无则只跑轨道 A。',
    '   - **后端/数据/CLI**：起服务 / `curl` / 查 SQLite / 跑测试。',
    '   - **命令约束**：不要前台运行 `dev`/`watch`/`preview` 等长驻服务(必要时 `timeout 30s` 或后台 + PID 清理)。不要现场 `pnpm add` / `pnpm install`。',
    '4. **报告（必须，增量写）**：**每验完一个 Scenario 立即** `task_write(taskId, "qa/verification_report.md", { content, overwrite: true })` 把已验的整体重写。每节 `## <Scenario 名>` + `结论: PASS/FAIL` + `证据:`(命令+输出/截图绝对路径) + FAIL 时三段 `现象:` / `根因:`(文件:行 + 现象，不确定写"待 engineer 确认") / `修复方案:`(具体动作)。末尾 `## 最终结论: PASS|FAIL`。',
    `5. **校验合规**：\`cd ${planningHome} && openspec validate <name> --strict\` 确认 change 文档合规(这是只读校验，**不要归档** —— 归档是 planner 在 S11 做的)。`,
    "6. **闭环 + propose**(只在 S7 时)：全 Scenario PASS → 先看本任务是否有 ci seat:",
    "   - **有 ci seat** → `task_state_propose(taskId, \"S9\", { artifacts: [\"qa/verification_report.md\"] })` 进 ci 监控",
    "   - **无 ci seat** → `chatroom_send` 宣布\"验收通过\" + `task_state_propose(taskId, \"S10'\", { artifacts: [\"qa/verification_report.md\"] })` 交回 planner 定稿/归档(M2 兼容)",
    "   - 任一 FAIL → **不要 propose 推进**(L2b/L2c 校验会拒)，先 `mention` engineer 列**具体**修复项(现象/根因/修复方案)等其修完只复验该项；engineer 长时间无响应再 `task_state_propose(taskId, \"S6\", { artifacts: [\"qa/verification_report.md\"] })` 显式回 repair。**qa 全程不动代码**。",
    '',
    "**收口规则**：进入 `S7` 或 `S10'` 后立即用已有证据收口报告，不要扩散源码扫描。某些 Scenario 无法本轮验/工具失败/实现不满足 spec → 也必须写 FAIL + 阻塞点。没有 `qa/verification_report.md` 视为 QA gate 失败。",
    '**预算**：截图 ≤ 12 张 · agent-browser 命令 ≤ 20 条 · 读源码 ≤ 8 个文件(仅定位 FAIL 根因时)。',
    '**重要**：每个 Scenario 都要有命令/截图证据，不许"应该没问题"。声称"验收通过/PASS"前，本条消息内必须有刚跑出的验证输出。',
  ].join('\n')

  // QA gate 模式（env 门控）：两段式 verify-only → repair，避免 engineer 过度实现 / qa 无界扫仓。
  const useGate = process.env['AGENT_TEAM_GATE'] === '1'
  const gateMaxFiles = process.env['AGENT_TEAM_GATE_MAX_FILES'] ?? '15'
  const gateMaxCmds = process.env['AGENT_TEAM_GATE_MAX_CMDS'] ?? '20'

  const engineerGatePrompt = [
    systemPromptBase,
    '',
    '---',
    workspaceInfoBlock,
    '',
    '---',
    '## 入场指示（QA Gate — engineer 两阶段工作模式: verify-only → on-demand repair）',
    '',
    '这是**验收 gate**。你按**两阶段**工作:',
    '- **阶段 1 verify-only(默认)**: 代码已实现完毕，你只跑锚点验证命令 + 写 test-report + propose。**严禁**实现新功能、重构、改动与"修复 QA 明确 FAIL 项"无关的文件(尤其 `biome.json` / config / 格式化)。',
    '- **阶段 2 on-demand repair(仅 QA 指派)**: QA 在 chatroom 明确给 FAIL 项 + `@你` 后，才修该具体项。修完只复验该项，不扩大范围。',
    '',
    '注意: qa 与你**同源**从规约 fork(它不消费你的 test-report 作输入，仅作白盒参考)。你不需要主动 push test-report 给 qa；它会基于规约独立跑证据。',
    '',
    '1. **同步**：`chatroom_recent` 拉 main；读 `plan/task-plan.md` 的「验收锚点」(= 固定验收命令清单 + acceptance matrix)。',
    `2. **跑固定验证命令(阶段 1)**：只跑锚点列出的命令，capture 完整输出 + 退出码；遵守命令约束(不前台跑 dev/watch，必要时 \`timeout 60s\`，不现场 pnpm add/install)。基线至少含：\`cd ${wt} && pnpm preflight\`。`,
    '3. **写报告**：`task_write(taskId, "eng/test-report.md", ...)`，含 `# Test Report` + `## 改动说明`(verify-only 轮写"无代码改动") + `## 结果`(逐条贴命令输出/退出码)。',
    "4. **propose**：有 qa seat → `task_state_propose(taskId, \"S7\", { artifacts: [\"eng/test-report.md\"] })` 进 qa 验收；无则 `task_state_propose(taskId, \"S10'\", ...)`(兼容)。然后**进入待命**。",
    '5. **repair(阶段 2，仅当 QA 指派)**：只有 QA `@你` + 给出 FAIL 现象/根因/修复方案 时才进入 —— **只改该 FAIL 项相关文件**，`git commit`，更新 `eng/test-report.md`，交回 QA 复验。不要主动找事做、不要扩大改动范围。',
    '',
    '**重要**：阶段 1 默认零代码改动。任何超出"跑验证命令 + 写报告"的改动都视为越权。',
  ].join('\n')

  const qaGatePrompt = [
    systemPromptBase,
    '',
    '---',
    workspaceInfoBlock,
    '',
    '---',
    '## 入场指示（QA Gate 发现式验收 — 有预算、按固定锚点、不许空报告/无界扫描）',
    '',
    `验收锚点 = \`plan/task-plan.md\` 的「验收锚点」+ 它指向的 openspec specs。**预算硬约束**：最多读 ${gateMaxFiles} 个文件、最多跑 ${gateMaxCmds} 条命令、尽快出报告。**禁止**逐文件通读或无界扫全仓 —— engineer 的 \`eng/test-report.md\` 仅作白盒参考(可引用已有命令输出)，**不能替代你自己跑的运行时证据**。`,
    '',
    '1. **同步**：`chatroom_recent` 拉 main；读 `plan/task-plan.md` 锚点(eng/test-report.md 仅作白盒参考)。',
    '2. **逐锚点核实**：对每条验收锚点自主跑证据，给 PASS/FAIL。',
    "   - **UI 锚点必跑轨道 A**：全局 CLI `agent-browser`(open/snapshot/click/fill/screenshot) 实际驱动浏览器；需要底层浏览器命令或验收工作流时读 `agent-browser` / `playwright-cli` skill。",
    '   - **后端/数据锚点**：复用 engineer 已跑出的命令输出 + 必要时自己补跑锚点里的固定命令，别另开探索。',
    '3. **报告（必须，增量写）**：**每验完一条立即** `task_write(taskId, "qa/verification_report.md", { content, overwrite: true })` 整体重写。**每条锚点一节** + `结论: PASS/FAIL` + `证据:`(命令+输出/退出码/截图绝对路径) + FAIL 时三段 `现象:` / `根因:`(文件:行 + 现象) / `修复方案:`(具体动作)。末尾 `## 最终结论: PASS|FAIL`。',
    "4. **闭环 + propose**(只在 S7 时)：全锚点 PASS → 先 `chatroom_recent` / `seat_list` **看本任务是否有 ci seat**:",
    "   - **有 ci seat** → `task_state_propose(taskId, \"S9\", { artifacts: [\"qa/verification_report.md\"] })` 进 ci 监控阶段(替代直接进 S10')",
    "   - **无 ci seat** → `task_state_propose(taskId, \"S10'\", { artifacts: [\"qa/verification_report.md\"] })`(M2 兼容路径)",
    "   - 任一 FAIL → **不要 propose 推进**(L2b/L2c 会拒)，先 `mention` engineer 列**具体**修复项(现象/根因/修复方案)等其修完只复验该项;engineer 长时间无响应再 `task_state_propose(taskId, \"S6\", { artifacts: [\"qa/verification_report.md\"] })` 显式回 repair。**qa 全程不动代码**。",
    '',
    "**收口规则**：进入 `S7` 或 `S10'` 后立即用已有证据收口，不要扩散扫描。声称 PASS 前本条消息内必须有刚跑出的命令输出。没有报告视为 QA gate 失败。",
  ].join('\n')

  // m2-ci-factory: ci 工厂入场提示。pm skill 是核心,本提示负责 agent-team 的路由约束。
  const ciLocal = process.env['AGENT_TEAM_CI_LOCAL'] !== '0' // 默认 stub 模式
  const ciPrompt = [
    systemPromptBase,
    '',
    '---',
    workspaceInfoBlock,
    '',
    '---',
    '## 入场指示（CI 监控 — 用 pm skill + 架构 override 不 self-fix）',
    '',
    `你已被招募在 S9 ci 监控阶段。worktree = \`${wt}\`；qa 已在 S7 PASS,你的任务是搬运 + 守门:MR / CI / comment → ready2merge。`,
    '',
    '1. **同步**：`chatroom_recent` 拉 main + `artifact_list`/`artifact_get` 读 task-plan / qa 的 verification_report.md / engineer 的 test-report.md(白盒参考)+ `git -C ' + wt + ' log` 看改动。',
    '2. **必读 pm skill(核心工作流)**：读 `pm` skill 和它的 references(remote-adapter / runtime-adapter / polling-state-machine / fix-comment-loop)。pm 是你的执行框架；本提示的路由约束优先级高于 pm 的 self-fix 默认行为。',
    '3. **可选工具 skill**：需要 rebase 时读 `rebase` skill；需要部署/发布时读 `deploy` skill。',
    ciLocal
      ? `4. **本地 stub 模式**(env \`AGENT_TEAM_CI_LOCAL=1\`,默认开):跳过真实 \`gh pr create\` / pm 远程 polling,直接 \`task_write(taskId, "ci/ci_report.md", ...)\` 写 stub 报告:含 \`# CI Report\`、\`## MR\`(stub link)、\`## CI\`(status PASS / failed-jobs 0)、\`## Comments\`(count 0)、\`## ready2merge\` 节值 \`true\`。`
      : '4. **真实模式**(env `AGENT_TEAM_CI_LOCAL=0`):走 pm 完整流程 —— remote-adapter 解析 MR、polling-state-machine 轮询、fix-comment-loop 处理 comment；遇到需要改源码的失败/评论时路由 engineer。',
    "5. **propose 推进**：`ci/ci_report.md` 含 `## ready2merge` 节值 `true` 后,`task_state_propose(taskId, \"S10'\", { artifacts: [\"ci/ci_report.md\"] })`。L2c gate 会校验 ready2merge 标记,缺失/false 会拒。",
    '',
    '**重要 — ci 绝不改源码**：架构 §3.6 + ci.yaml workingHabits + 本提示三层硬约束。任何 `accepted` disposition / CI 失败需 fix → **路由 engineer**(写 `ci/ci-issues-{n}.md` + `chatroom_send` `mention` engineer),不 self-fix。',
  ].join('\n')

  const ciGatePrompt = [
    systemPromptBase,
    '',
    '---',
    workspaceInfoBlock,
    '',
    '---',
    '## 入场指示（CI Gate — 预算化、按固定锚点出报告）',
    '',
    `你已被招募在 S9 ci 监控 gate 阶段。**预算硬约束**：最多读 ${gateMaxFiles} 个文件、最多跑 ${gateMaxCmds} 条命令(主要是 git/gh/curl/pm)。`,
    '',
    '1. **同步**：`chatroom_recent` + 读 `plan/task-plan.md` + qa 的 verification_report 确认 qa PASS。',
    '2. **必读 pm skill + 本提示 override**(同非 gate 模式,工作流以 pm 为底,源码修复路由 engineer)。',
    ciLocal
      ? '3. **本地 stub**(默认):直接写 `ci/ci_report.md` stub(MR link / CI PASS / Comments 0 / `## ready2merge` 值 true),跳过远程交互。'
      : '3. **真实模式**:跑 pm 流程,失败/accepted 类 disposition 路由 engineer。',
    "4. **propose**：`task_state_propose(taskId, \"S10'\", { artifacts: [\"ci/ci_report.md\"] })`,L2c gate 校验 ready2merge。",
    '',
    '**重要**：ci 默认零代码改动。任何 worktree 内源文件改动都视为越权。',
  ].join('\n')

  const initialPrompt =
    factoryName === 'qa'
      ? useGate
        ? qaGatePrompt
        : useOpenspec
          ? qaOpenspecPrompt
          : qaPrompt
      : factoryName === 'ci'
        ? useGate
          ? ciGatePrompt
          : ciPrompt
        : useGate
          ? engineerGatePrompt
          : useOpenspec
            ? engineerOpenspecPrompt
            : engineerPrompt

  spawningSeats.add(seatId)
  publishPresence(seatId, null, null)

  log.info({ seatId, factory: factoryName }, 'spawning engineer')

  let spawnResult: Awaited<ReturnType<typeof spawnAgent>>
  try {
    const runtimeResolution = await resolveRuntimeCandidatesForSpawn(
      engineerFactory,
      seatRow.model_override,
    )
    if (runtimeResolution.candidates.length === 0) {
      throw new Error(
        `no available model profiles for ${factoryName}; skipped ${runtimeResolution.skipped
          .map((s) => s.modelProfile.provider)
          .join(', ')}`,
      )
    }
    spawnResult = await spawnWithRuntimeFallback(factoryName, runtimeResolution.candidates, (modelProfile) =>
      spawnAgentWithProbe({
        label: factoryName,
        factory: engineerFactory,
        runtime: modelProfile,
        initialPrompt: initialPrompt.replace('{{displayName}}', '待确定'),
        extraMcps: factoryName === 'engineer' ? engineerExtraMcps : [],
        deps: makeSpawnDeps(factoryName),
        taskWorktree: worktreeReady ? wt : '',
        seatId,
      }),
    )
  } catch (err) {
    const detail = err instanceof Error ? (err.stack ?? err.message) : JSON.stringify(err)
    log.error({ seatId, errDetail: detail }, 'failed to spawn engineer')
    spawningSeats.delete(seatId)
    publishPresence(seatId, null, null)
    throw new Error(detail)
  }

  // 写 agents 表
  db.prepare(
    `INSERT OR IGNORE INTO agents
     (id, task_id, seat_id, factory, display_name, state, factory_version, model_profile, spawned_at)
     VALUES (?, ?, ?, ?, ?, 'idle', ?, ?, ?)`,
  ).run(
    spawnResult.agentId,
    taskId,
    seatId,
    factoryName,
    spawnResult.displayName,
    engineerFactory.version,
    spawnResult.modelProfile ? JSON.stringify(spawnResult.modelProfile) : null,
    new Date().toISOString(),
  )

  agentSessions.set(spawnResult.agentId, spawnResult.sessionId)
  seatToAgent.set(seatId, spawnResult.agentId)

  log.info(
    {
      seatId,
      agentId: spawnResult.agentId,
      displayName: spawnResult.displayName,
      sessionId: spawnResult.sessionId,
      modelProfile: spawnResult.modelProfile,
    },
    'engineer spawned successfully',
  )

  spawningSeats.delete(seatId)
  publishPresence(seatId, spawnResult.agentId, spawnResult.displayName)

  startAgentWork({
    agentId: spawnResult.agentId,
    sessionId: spawnResult.sessionId,
    seatId,
    displayName: spawnResult.displayName,
    factoryName,
    prompt: initialPrompt.replace('{{displayName}}', spawnResult.displayName),
    intro: `我已入场，身份是 ${spawnResult.displayName}（${factoryName}）。我会先同步上下文和任务制品，然后按当前阶段开始工作。`,
  })
}

function shutdown(): void {
  mcpCtx
    .stopHttpServer()
    .catch(() => {})
    .finally(() => {
      db.close()
      process.exit(0)
    })
}

/**
 * 主启动序列：
 * 1. 起 HTTP MCP server
 * 2. 加载工厂
 * 3. spawn planner（含 chatroom-mcp HTTP 注入）
 * 4. 发 lifecycle-ready
 */
async function boot(): Promise<void> {
  // parent-death monitor:server 进程死了(SIGKILL / 崩 / pkill)→ 本 task-process
  // 会被 reparent 到 launchd/init,process.ppid 变化 → 主动自杀,防 zombie 抢占 mcp 端口
  // 干扰新 server 的 launcher 状态。
  const origParentPid = process.ppid
  setInterval(() => {
    if (process.ppid !== origParentPid) {
      log.warn(
        { origParentPid, newParentPid: process.ppid },
        'task-process: parent died (reparented), suiciding to avoid zombie state',
      )
      process.exit(0)
    }
  }, 2000).unref() // unref:不阻塞 event loop 正常退出

  // 防静默 timer watchdog:兜"卡 working 永不 done / 长时间无进展"(phase-driven-orchestration)
  setInterval(() => {
    try {
      runWatchdogTick()
    } catch (err) {
      log.warn({ err }, 'watchdog tick failed (non-fatal)')
    }
  }, WATCHDOG_TICK_MS).unref()

  // 启动 chatroom-mcp HTTP server
  const mcpPort = await mcpCtx.startHttpServer()
  log.info({ mcpPort }, 'chatroom-mcp HTTP server ready')

  // 加载工厂
  loadFactories(factoriesDir, log)

  // bugfix(M3 T6):把用户初始输入(POST /tasks 的 description + 链接拼接)
  // 作为第一条 human-msg 写入 chatroom,这样前端打开 chatroom 能看到自己刚才填的内容。
  // 原实现只塞 planner 的 system prompt,用户在前端看不到自己的输入。
  // idempotent:只检查"有没有任何 human-msg 来自 human",避免被 bootstrap
  // runner 早写的 system-event 干扰(它在 boot 之前已落表)。
  if (initialHumanMsg.trim()) {
    const existing = db
      .prepare(
        "SELECT COUNT(*) as n FROM chatroom_messages WHERE task_id = ? AND type = 'human-msg' AND sender = 'human'",
      )
      .get(taskId) as { n: number }
    if (existing.n === 0) {
      writeChatroomMsg('human', 'main', 'human-msg', initialHumanMsg)
      log.info({ contentLen: initialHumanMsg.length }, 'wrote initial human message to chatroom')
    }
  }

  // 启动 reconcile:本进程全新,DB 里任何"在场"agent 都来自上个(已死)进程,session 不存在。
  // 把这些 agent 标 terminated;本进程 seatToAgent 为空,对应 seat presence 自然派生为 vacant。
  // working/idle、避免 pause 等操作对着死 agent 空打。当前阶段需要的 driver 由下面 resumeFromState
  // 重新 spawn;其余 seat 之后按需 wake 重生(wake 已支持 vacant→spawn)。
  // (全新 task 首 boot 时还没任何 agent → no-op。)
  {
    const stale = db
      .prepare("SELECT id, seat_id FROM agents WHERE state != 'terminated'")
      .all() as { id: string; seat_id: string | null }[]
    if (stale.length > 0) {
      db.prepare("UPDATE agents SET state = 'terminated' WHERE state != 'terminated'").run()
      for (const a of stale) {
        if (!a.seat_id) continue
        publishPresence(a.seat_id, null, null)
      }
      log.info({ count: stale.length }, 'boot reconcile: stale agents → terminated, seats → vacant')
    }
  }

  const currentTask = db.prepare('SELECT state FROM tasks_meta WHERE id = ?').get(taskId) as
    | { state: string }
    | undefined
  // agent-driven 阶段(engineer/qa/ci 驱动)resume:懒式只拉当前 driver
  if (currentTask && ['S6', 'S7', 'S9'].includes(currentTask.state)) {
    await resumeFromState(currentTask.state as TaskState)
    return
  }

  const plannerFactory = getFactory('planner')
  if (!plannerFactory) {
    log.error({ factoriesDir }, 'planner factory not found — cannot spawn planner')
    process.send?.({
      type: 'task-event',
      subtype: 'notification',
      taskId,
      level: 'error',
      content: `planner 工厂未找到（factoriesDir=${factoriesDir}），任务无法启动`,
    } satisfies TaskEvent)
    return
  }

  // 复用或创建 planner seat
  // M3 T11 fix:auto-relaunch 时如果已有 planner seat,复用同一个(spawnAgent 内
  // 会在本进程内存 seatToAgent 指到新 planner 实例);否则首次 boot 才创建。
  // 否则每次 server 重启 + 用户发消息触发 auto-relaunch 都会在 DB 多出一条
  // planner seat,@-mention picker 出现重复。
  const existingPlanner = db
    .prepare(
      "SELECT id FROM seats WHERE task_id = ? AND factory = 'planner' ORDER BY created_at LIMIT 1",
    )
    .get(taskId) as { id: string } | undefined
  const seatId = existingPlanner?.id ?? newSeatId()
  if (!existingPlanner) {
    db.prepare(
      `INSERT INTO seats (id, task_id, role, factory, status, created_at)
       VALUES (?, ?, 'planner', 'planner', 'init', ?)`,
    ).run(seatId, taskId, new Date().toISOString())
  }

  // 组装 planner SpawnDeps
  const spawnDeps: SpawnDeps = makeSpawnDeps('planner')

  // 渲染 planner initialPrompt
  const agentMdPath = path.join(__dirname, '../../../../agent.md')
  let agentMdContent = ''
  if (fs.existsSync(agentMdPath)) {
    agentMdContent = fs.readFileSync(agentMdPath, 'utf-8')
  }

  // spawnAgent 内部会抽签 displayName，这里先用占位符
  const systemPromptBase = renderSystemPromptBase(plannerFactory, taskTitle, agentMdContent)

  // Phase 3.3: worktree 不再由 task-process 假设为 ready;从 bootstrap_resources 读真实状态。
  // bootstrap runner 与 planner 并行启动,此刻 resource 可能是 creating/ready/failed/不存在。
  const bootstrapRow = db
    .prepare(
      `SELECT status, path, branch, provider, mode, summary, error
         FROM bootstrap_resources
        WHERE task_id = ? AND id = 'primary-worktree'`,
    )
    .get(taskId) as
    | {
        status: string
        path: string | null
        branch: string | null
        provider: string
        mode: string | null
        summary: string | null
        error: string | null
      }
    | undefined

  const worktreeStatusBlock = bootstrapRow
    ? [
        `- **bootstrap provider/mode**：\`${bootstrapRow.provider}\`/\`${bootstrapRow.mode ?? 'default'}\``,
        `- **bootstrap status**：\`${bootstrapRow.status}\`${bootstrapRow.summary ? `（${bootstrapRow.summary}）` : ''}`,
        bootstrapRow.status === 'ready' && bootstrapRow.path
          ? `- **代码 worktree 绝对路径**：\`${bootstrapRow.path}\`${bootstrapRow.branch ? `（分支 \`${bootstrapRow.branch}\`）` : ''}`
          : `- **代码 worktree 路径**：尚未就绪。等 bootstrap 推到 ready 后从 \`task_resource_get\` 读取，再交给 engineer。${bootstrapRow.error ? `（当前错误：${bootstrapRow.error}）` : ''}`,
      ].join('\n')
    : [
        '- **bootstrap status**：尚未启动或采用 `none` provider（不为本任务准备业务 worktree）。',
        '- 你 planner 不需要也不应该亲自 `sw`/`git worktree`——基础设施由 orchestrator 的 bootstrap runner 接管。',
      ].join('\n')

  // PoC 门控：AGENT_TEAM_OPENSPEC=1 时 planner 用 openspec-propose skill 产出 change（文档驱动），
  // 否则走默认 task_write task-plan.md。
  const useOpenspec = process.env['AGENT_TEAM_OPENSPEC'] === '1'
  const planStep = useOpenspec
    ? [
        '2. **用 `openspec-propose` skill 把本任务落成一个 openspec change**（你已装好该 skill + `openspec` CLI）：',
        `   - planning home = 任务管理目录 \`${taskWorkdir}\`（OpenSpec change 文档**只能写这里**，与代码 worktree 完全隔离；**不要 \`cd\` 进 bootstrap worktree 跑 openspec 命令**）。`,
        `   - 在该目录下跑 openspec 命令（每条命令前都 \`cd ${taskWorkdir}\`）。按 skill 指引：\`openspec new change <kebab-name>\` 创建，再用 \`openspec instructions <artifact> --change <name> --json\` 拿模板，依次产出 proposal.md / design.md / specs/(delta) / tasks.md。`,
        '   - **specs/ delta 里的 Scenario（WHEN/THEN + SHALL/MUST）就是给 qa 的验收锚点**，必须写得具体可验证。',
        `   - 完成后该目录应有 \`${taskWorkdir}/openspec/changes/<name>/\` 下的文件。无法跑 AskUserQuestion 时改用 \`chatroom_send\` 问用户。`,
        '   - **仅在人类已明确确认待澄清问题后**，紧接着 `task_write(taskId, "plan/task-plan.md", ...)` 写一个瘦计划，必须含两个 section：`## seatPlan`（要招的座位：engineer + qa）和 `## 验收锚点`（写「详见 `openspec/changes/<name>/specs/`，qa 按其中每个 Scenario 逐条验收」）。这是 propose S2 通过校验所必需。',
        "2b. **兼任 pm-ux 出 acceptance + (前端时) visual-contract**（强烈建议）：`task_write(taskId, \"plan/acceptance.md\", ...)` 把每个 spec Scenario 翻成「用户操作 → 期望结果」正向清单(qa 轨道 A 直接消费)。若任务涉 UI / 页面 / 交互，再 `task_write(taskId, \"plan/visual-contract.md\", ...)` 写视觉契约(关键元素位置 / 状态视觉 / a11y 树伪代码;**不像素级**)。propose S2 的 artifacts 把这两份(若有)也一并列上,qa 在轨道 B 对照截图核验。",
      ]
    : [
        '2. `task_write(taskId, "plan/task-plan.md", <计划>)` —— 简要计划，必须含 `## seatPlan`（要招的座位）和 `## 验收锚点`（验收标准）两个 section。**不需要精确到行**。',
        '2b. **兼任 pm-ux 出 acceptance + (前端时) visual-contract**（强烈建议）：',
        '   - `task_write(taskId, "plan/acceptance.md", ...)` 写**正向交互预期清单**(用户操作 → 期望结果,逐条;qa 轨道 A 直接消费,**不要写"哪里坏了"**)',
        '   - 若 task 涉 UI / 页面 / 交互/视觉/布局 → 再 `task_write(taskId, "plan/visual-contract.md", ...)` 写视觉契约:关键元素位置 + 状态视觉 + a11y 树伪代码;**文字 + ASCII + 结构化清单,不像素级**(你不是设计师)。qa 在轨道 B 对照截图核验',
        '   - 拿不准 task 性质 → 入场对齐时问人类一句"这个 task 有 UI 改动吗?"',
      ]
  // S2 propose 的 artifacts:plan/task-plan.md 必出;acceptance.md / visual-contract.md 若有 planner 应一并加进去
  const proposeArtifacts = '["plan/task-plan.md"](若出了 acceptance / visual-contract 也一并列)'
  // archive-task 门控：AGENT_TEAM_TASK_KIND=archive + AGENT_TEAM_ARCHIVE_CHANGE=<name> 时，
  // planner 只做 openspec-archive-change（其 S11 定稿职责），不规划/招募。
  const archiveChangeName = process.env['AGENT_TEAM_ARCHIVE_CHANGE']
  // D5: 默认在 planning home (taskWorkdir) 归档；仅当任务显式声明要改业务仓库 OpenSpec
  // (env AGENT_TEAM_ARCHIVE_IN_WORKTREE=1) 且 bootstrap 已 ready 时才 cd 进业务 worktree。
  const archiveInWorktree =
    process.env['AGENT_TEAM_ARCHIVE_IN_WORKTREE'] === '1' &&
    bootstrapRow?.status === 'ready' &&
    !!bootstrapRow.path
  const archiveWorktree = archiveInWorktree ? bootstrapRow.path! : taskWorkdir
  const archivePrompt = [
    systemPromptBase,
    '',
    '---',
    '## 本任务：归档 openspec change（你 planner 的 S11 定稿职责）',
    `用 \`openspec-archive-change\` skill 把 change **\`${archiveChangeName}\`** 归档（它已实现完 + strict valid）：`,
    archiveInWorktree
      ? `1. \`cd ${archiveWorktree}\`（任务显式声明归档业务仓库 OpenSpec，已切到 bootstrap worktree）。`
      : `1. \`cd ${archiveWorktree}\`（planning home = 任务管理目录；OpenSpec change 默认在这里归档，不污染业务 worktree）。`,
    `2. 按 skill 流程：\`openspec status --change ${archiveChangeName} --json\` 确认 tasks 完成；归档时把 delta specs **sync now**（并回 \`openspec/specs/\`）。**只有这一个目标 change，直接选它**，不要卡在 AskUserQuestion——无法交互就按推荐项继续。`,
    `3. 归档后：\`cd ${archiveWorktree} && git add -A && git commit -m "chore: archive ${archiveChangeName}"\`。`,
    '4. `chatroom_send` 在 main 报告：change 已归档、动了哪些 specs、git commit hash。',
    '**只做归档，不要规划/招募/写 plan/propose。**',
  ].join('\n')
  // 若 task 已在 releasing(server 重启 / auto-relaunch 时常见),
  // 不要用"起任务"的 START prompt 误导 planner;直接用 retro prompt
  // 让新 planner 接续做收尾 → propose done。
  const isResumingReleasing = currentTask?.state === 'releasing'
  const initialPrompt =
    isResumingReleasing
      ? [
          systemPromptBase,
          '',
          '---',
          '## 当前:releasing 收尾阶段',
          '任务已由人类确认完成,进入 releasing。按你 systemPromptTemplate 的 releasing/S11 复盘职责执行:',
          '产出 `retro/retrospective.md` + `retro/archive-plan.md`,然后 `task_state_propose("done")`。',
          'orchestrator 会先把 bootstrap resources 推到终态,再校验 retro+archive-plan 存在且 resources 全终态才放行。',
        ].join('\n')
      : process.env['AGENT_TEAM_TASK_KIND'] === 'archive' && archiveChangeName
      ? archivePrompt
      : [
    systemPromptBase,
    '',
    '---',
    '## 本任务环境',
    `- **任务管理目录**：\`${taskWorkdir}\`（planner planning home：plan/、retro/、openspec change 都在这里写）`,
    worktreeStatusBlock,
    `- **任务标题**：${taskTitle}`,
    '',
    '## 任务初始信息（用户填写）',
    '',
    initialHumanMsg || '（用户未填写初始信息，请先通过 chatroom_send 询问用户任务详情）',
    '',
    '---',
    '## 重要：你是 planner，不是 engineer',
    '你的职责是**轻量规划 + 委派**，不是自己定位到行级修复。**最多读 3-5 个文件**形成粗粒度理解即可，',
    '**不要**把 bug 深挖到具体改哪一行——那是 engineer 的活。理解大致改动区域后，立刻进入下面的交付序列。',
    '',
    '## 对齐门禁（最高优先级）',
    '在进入下面操作序列之前,你必须先完成 systemPromptTemplate 的"入场对齐":',
    '1. 发 `agent-text` 说明任务理解、已知信息、待澄清问题。',
    '2. 若有任何待澄清问题,再发一条 `system-event`，内容以 `⚠ 等待人类确认:` 开头,明确说你会暂停规划/建岗/propose。',
    '3. **停下等待人类回复**。最近 human-msg 没有明确确认/回答前,禁止写 plan/acceptance/visual-contract,禁止 seat_create,禁止 task_state_propose。',
    '只有人类已明确确认后,才执行下面序列。',
    '',
    '## 你接下来的明确操作序列（仅在人类对齐确认后执行，按顺序，不要一直探索）',
    '1.（可选，≤5 个文件，仅在 bootstrap status=ready 时）粗看 worktree 确认改动大致落在哪个模块；未 ready 时跳过这一步，等 bootstrap 完成或委派 engineer 探查。',
    ...planStep,
    '3. **建岗位 — 三个全建,无例外**:',
    '   - `seat_create(taskId, role="Engineer #1", factory="engineer")` — 必须',
    '   - `seat_create(taskId, role="QA #1", factory="qa")` — 必须(S10\' gate 要 `qa/verification_report.md`,缺则任务卡死)',
    '   - `seat_create(taskId, role="CI #1", factory="ci")` — 必须(qa pass 后 ci 负责本地启动 / 推 MR / 监控 review,缺则任务无法交付)',
    '   规则:不要纠结"这个任务需不需要 qa/ci",**默认全建**。即使用户在描述里说"不要 qa / 不用 ci" 也照样建并在 chatroom 解释为什么必建(gate 设计就这样)。',
    `4. \`task_state_propose(taskId, "S2", { artifacts: [...] })\` —— 推进招募（artifacts 填 ${proposeArtifacts}），系统自动 spawn 你建的所有岗位(engineer + qa + ci)。`,
    '5. agent 起来后用 `chatroom_send`（mention 对应 seatId）把任务交接：让 engineer 实现/修复,让 qa 对照验收锚点核实,ci 在 qa pass 后再唤起。',
    '**目标：尽快把活交给 engineer/qa/ci。** 第 2-4 步要在几次工具调用内完成,不要无限探索。',
  ].join('\n')

  log.info({ factory: 'planner' }, 'spawning planner agent')
  spawningSeats.add(seatId)
  publishPresence(seatId, null, null)

  let spawnResult: Awaited<ReturnType<typeof spawnAgent>>
  try {
    const runtimeResolution = await resolveRuntimeCandidatesForSpawn(plannerFactory)
    if (runtimeResolution.candidates.length === 0) {
      throw new Error(
        `no available model profiles for planner; skipped ${runtimeResolution.skipped
          .map((s) => s.modelProfile.provider)
          .join(', ')}`,
      )
    }
    spawnResult = await spawnWithRuntimeFallback('planner', runtimeResolution.candidates, (modelProfile) =>
      spawnAgentWithProbe({
        label: 'planner',
        factory: plannerFactory,
        runtime: modelProfile,
        initialPrompt: initialPrompt.replace('{{displayName}}', '待确定'),
        deps: spawnDeps,
        seatId,
      }),
    )
  } catch (err) {
    const detail =
      err instanceof Error
        ? (err.stack ?? err.message)
        : JSON.stringify(err, Object.getOwnPropertyNames(err ?? {}))
    log.error({ errDetail: detail }, 'failed to spawn planner')
    spawningSeats.delete(seatId)
    publishPresence(seatId, null, null)
    process.send?.({
      type: 'task-event',
      subtype: 'notification',
      taskId,
      level: 'error',
      content: `planner spawn 失败：${detail}`,
    } satisfies TaskEvent)
    return
  }

  plannerAgentId = spawnResult.agentId
  agentSessions.set(spawnResult.agentId, spawnResult.sessionId)
  seatToAgent.set(seatId, spawnResult.agentId)

  // 写 agents 表
  db.prepare(
    `INSERT OR IGNORE INTO agents
     (id, task_id, seat_id, factory, display_name, state, factory_version, model_profile, spawned_at)
     VALUES (?, ?, ?, 'planner', ?, 'idle', ?, ?, ?)`,
  ).run(
    spawnResult.agentId,
    taskId,
    seatId,
    spawnResult.displayName,
    plannerFactory.version,
    spawnResult.modelProfile ? JSON.stringify(spawnResult.modelProfile) : null,
    new Date().toISOString(),
  )

  log.info(
    {
      agentId: spawnResult.agentId,
      displayName: spawnResult.displayName,
      sessionId: spawnResult.sessionId,
      symlinkFallback: spawnResult.symlinkFallback,
      modelProfile: spawnResult.modelProfile,
    },
    'planner spawned successfully',
  )

  spawningSeats.delete(seatId)
  publishPresence(seatId, spawnResult.agentId, spawnResult.displayName)

  startAgentWork({
    agentId: spawnResult.agentId,
    sessionId: spawnResult.sessionId,
    seatId,
    displayName: spawnResult.displayName,
    factoryName: 'planner',
    prompt: initialPrompt.replace('{{displayName}}', spawnResult.displayName),
    intro: `我已入场，身份是 ${spawnResult.displayName}（planner）。我会先同步上下文，确认任务理解，再给出计划和下一步招募安排。`,
  })

  // bugfix(M3 维护):planner spawn 后自动 S0→S1(human-start by system)。
  // 这条转移 allowedBy=['human','system'],原本无任何代码触发,导致 planner
  // 永远卡在 S0 无法 propose S1→S2。M1 dogfood 都 seed 在 S6 跳过该段,
  // 所以未暴露;M3 起前端表单走 planner 全流程时撞到。
  const currentS0 = db.prepare('SELECT state FROM tasks_meta WHERE id = ?').get(taskId) as
    | { state: string }
    | undefined
  if (currentS0?.state === 'S0') {
    advanceState('S0', 'S1', 'system')
  }

  // 发 lifecycle-ready
  process.send?.({ type: 'lifecycle-ready', taskId })
  log.info('task-process ready — planner spawned')
}

/**
 * 从 agent-driven 阶段(S6/S7/S9)resume:**只** spawn 当前 state 的 driver seat,
 * 不再 spawn-all 非 planner seat(否则 resume 会过早拉起 qa/ci,破坏懒式)。
 * driver 由 driversForState 派生(S6→engineer / S7→qa / S9→ci)。
 */
async function resumeFromState(state: TaskState): Promise<void> {
  const factories = getAllFactories().map((f) => ({
    name: f.name,
    proposeTransitions: f.defaultPermissions.proposeTransitions,
  }))
  const drivers = driversForState(state, factories)
  const placeholders = drivers.map(() => '?').join(',')
  const seats = drivers.length
    ? (db
        .prepare(
          `SELECT id FROM seats WHERE task_id = ? AND factory IN (${placeholders}) ORDER BY created_at`,
        )
        .all(taskId, ...drivers) as Array<{ id: string }>)
    : []

  if (seats.length === 0) {
    log.error({ state, drivers }, 'resumeFromState: 当前 state 无 driver seat 可恢复')
    process.send?.({
      type: 'task-event',
      subtype: 'notification',
      taskId,
      level: 'error',
      content: `无法从 ${state} 恢复:DB 中没有 ${drivers.join('/')} seat`,
    } satisfies TaskEvent)
    return
  }

  log.info({ state, drivers, seatIds: seats.map((s) => s.id) }, 'resuming task (lazy, driver-only)')
  await Promise.all(seats.map((seat) => spawnEngineerForSeat(seat.id)))
  process.send?.({ type: 'lifecycle-ready', taskId })
  log.info({ state }, 'task-process ready — resumed (lazy)')
}

// 优雅关闭
process.on('SIGTERM', () => {
  log.info('task-process SIGTERM received')
  shutdown()
})

process.on('uncaughtException', (err) => {
  log.error({ err }, 'task-process uncaughtException')
  shutdown()
})

// 启动
boot().catch((err) => {
  log.error({ err }, 'task-process boot failed')
  process.exit(1)
})
