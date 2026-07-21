# chatroom-protocol Specification

## Purpose
TBD - created by archiving change m1-skeleton. Update Purpose after archive.
## Requirements
### Requirement: chatroom-mcp 提供 13 个 stdio MCP 工具

chatroom-mcp 模块 SHALL 通过 MCP 协议向每个 agent 暴露通信、制品、岗位、状态机、文件写入、观察和 task resource 查询工具。工具至少包含:`chatroom_send` / `chatroom_listen` / `chatroom_recent` / `artifact_register` / `artifact_list` / `artifact_get` / `seat_create` / `seat_list` / `seat_status_get` / `task_state_get` / `task_state_propose` / `task_write` / `context_log` / `task_resource_get`。

#### Scenario: agent 启动加载工具

- **WHEN** agent CLI 子进程 spawn 时通过 mcp 配置加载 chatroom-mcp
- **THEN** agent 在工具列表中能看到上述工具,可以直接调用

#### Scenario: agent 查询 task resources

- **WHEN** planner 或 engineer 调用 `task_resource_get(taskId)`
- **THEN** chatroom-mcp MUST 返回该 task 的 bootstrap resources,包括 worktree status/path/branch/mode/provider/error

### Requirement: chatroom_send 消息发送 + mention 路由

`chatroom_send(channel, type, content, refs?, mention?, replyTo?)` SHALL 接收消息并按 mention 数组中每个 seatId 的岗位状态智能路由:`idle`/`working` 直接派发,`offline`(SIGSTOP)后端透明 SIGCONT 唤醒,`vacant`(crash 重 spawn 中)消息入 seat.queue 等新实例 ready 后完整回放。

#### Scenario: 发到 idle 岗位

- **WHEN** agent 调 `chatroom_send(channel='main', type='handoff', content='请审 PR', mention=['eng-1'])` 且 `eng-1` 岗位为 idle
- **THEN** chatroom-mcp 写消息到 `chatroom.jsonl`,在 SQLite 索引,通过 `eng-1` 的 chatroom_listen 长轮询推给该 agent,WS 同步广播给前端

#### Scenario: 发到 offline 岗位

- **WHEN** mention 目标岗位 status==offline(进程 SIGSTOP)
- **THEN** 后端 SIGCONT 唤醒该岗位,转 idle/working,然后正常路由;对发送方透明(不知道经过了 sleep)

#### Scenario: 发到 vacant 岗位

- **WHEN** mention 目标岗位 status==vacant(crash 重 spawn 中)
- **THEN** 消息入 `seat.queue`,新实例 ready 后,chatroom-mcp 把 queue 中所有消息原样回放给它;返回值 `queuedSeats` 包含该 seatId 让发送方知情

### Requirement: chatroom_listen 长轮询

`chatroom_listen(channel, since?, timeoutMs=30000)` MUST 实现长轮询:阻塞最多 `timeoutMs` 毫秒;期间有新消息立即返回;`since` 指定上次拿到的 messageId,服务端从这之后切片返回。系统 MUST 在返回非空 payload 时估算该 payload 的 chatroom read token，并将其归因到调用 agent；该统计 MUST 标记为 chatroom context usage，而不是 provider runtime usage。

#### Scenario: 长轮询命中

- **WHEN** agent 调 `chatroom_listen(channel='main', since='msg-100', timeoutMs=30000)` 且立即有新消息 msg-101
- **THEN** 长轮询不阻塞,立即返回 `[msg-101]`
- **AND** 系统写入一条归因到该 agent 的 chatroom read token 统计事件

#### Scenario: 长轮询超时

- **WHEN** 30s 内没有新消息
- **THEN** 返回空数组 `[]`,agent 自行决定是否再发起 listen
- **AND** 系统 MUST NOT 写入非零 chatroom read token 事件

### Requirement: chatroom_recent 历史拉取

`chatroom_recent(channel, n=20)` SHALL 返回最近 n 条消息(按时间倒序加载,正序返回),用于 agent 入场快速拿上下文。系统 MUST 在返回消息 payload 时估算该 payload 的 chatroom read token，并将其归因到调用 agent；该统计 MUST 与 provider runtime usage 分开存储和展示。

#### Scenario: 新 agent 入场拉历史

- **WHEN** 刚 spawn 的 agent 调 `chatroom_recent(channel='main', n=50)`
- **THEN** 返回 main 频道最近 50 条消息(若不足 50 则全部)
- **AND** 系统写入一条归因到该 agent 的 chatroom read token 统计事件

#### Scenario: chatroom_recent 返回空

- **WHEN** agent 调 `chatroom_recent(channel='main', n=20)` 且该频道没有消息
- **THEN** 返回空消息数组
- **AND** 系统 MUST NOT 写入非零 chatroom read token 事件

### Requirement: 频道分层

chatroom 内消息 SHALL 按 4 个频道分流:`main`(默认,所有 agent 与人订阅)/ `eng-internal`(engineer 自言自语 / 子任务简报)/ `tool-traces`(tool 调用流,默认前端折叠)/ `mentions`(@ 路由专门频道)。

#### Scenario: 默认订阅

- **WHEN** agent 启动 + spawn 流程完成
- **THEN** agent 默认订阅 `main` + `mentions` 频道;`eng-internal` 仅 engineer 工厂订阅;`tool-traces` 工厂可配置

### Requirement: seat 创建与状态查询

`seat_create(taskId, role, factory)` / `seat_list(taskId)` / `seat_status_get(seatId)` MUST 提供岗位管理。planner 在 S1 出 seatPlan 时调用 `seat_create` 把每个岗位注册到系统;`seat_list` 列出所有岗位 + 当前状态;`seat_status_get` 详查单岗位。

#### Scenario: planner 编排 seatPlan

- **WHEN** planner 在 S1 完成规划,需要为 engineer 岗位注册
- **THEN** planner 调 `seat_create(taskId, role='Engineer #1', factory='engineer')`,chatroom-mcp 返回 `{seatId: 'eng-1'}` 并把岗位状态设为 `vacant`

### Requirement: Seat 状态机

岗位 SHALL 在 5 个状态间转换:`init`(spawn 中)/ `idle`(空闲待命)/ `working`(处理消息中)/ `offline`(长时间 idle 后被 SIGSTOP)/ `vacant`(crash 中,等重 spawn)。`offline` 是 idle 的子态,后端 SIGCONT 即恢复,对发送方透明;`vacant` 只来自 crash,orchestrator 自动重 spawn,不会卡死。

#### Scenario: idle 长时进入 offline

- **WHEN** 岗位 idle 超过 5 分钟无新活动
- **THEN** 后端对该 agent 进程发 SIGSTOP,岗位状态 `idle → offline`,seat.queue 开始接收 mention

#### Scenario: vacant 自动重 spawn

- **WHEN** agent 进程异常退出(非 SIGTERM)
- **THEN** 标记岗位 `vacant`,orchestrator 立即从工厂模板 spawn 新实例(新 agent-id + 新 displayName),岗位回到 `init → idle`

### Requirement: task_state_get 与 task_state_propose

`task_state_get(taskId)` SHALL 返回当前状态机位置 + history + dashboard;`task_state_propose(taskId, targetState, evidence)` SHALL 让 agent 提议状态转移,orchestrator 经三层校验后决策接受/拒绝。每个工厂的 `defaultPermissions` 限定其可 propose 的转移集(详见 task-lifecycle spec)。

#### Scenario: planner propose S1→S2

- **WHEN** planner 完成 `plan/task-plan.md` 并调 `task_state_propose(taskId, 'S2', evidence={artifacts:['task-plan-id']})`
- **THEN** orchestrator 三层校验通过 → 写入状态 `S2` → 广播 `phase-change` → 返回 `{accepted: true, newState: 'S2'}`

#### Scenario: 拒绝跨权限的 propose

- **WHEN** engineer 尝试 propose `S1 → S2`(超出其权限)
- **THEN** chatroom-mcp 拒绝,返回 `{accepted: false, reason: 'permission denied: engineer 不能 propose S1→S2'}`

### Requirement: task_write 受控文件写入

`task_write(taskId, path, content, overwrite?)` SHALL 为 agent 提供对 artifact 目录(`plan/`, `eng/`, `retro/` 等)的受控写入能力。task-process 是一级目录 owner,agent 不可直接写这些目录,必须通过此工具。

handler 逻辑:
1. 校验 `path` 相对于 task-workdir,且在允许的一级目录内(不允许写 `agents/`、`chatroom.jsonl`、`state.json`)
2. 校验调用者角色有权写目标目录(planner → `plan/` + `retro/`,engineer → `eng/`)
3. 入 FIFO 队列,按请求到达时间串行执行
4. 写入文件(目录不存在则递归创建),返回 `{success, bytesWritten}`
5. `overwrite` 默认 false,文件已存在时拒绝;设为 true 则覆盖

#### Scenario: engineer 写 test-report

- **WHEN** engineer 调 `task_write(taskId, path='eng/test-report.md', content='# Test Report\n...', overwrite=true)`
- **THEN** task-process 校验 engineer 角色可写 `eng/` → 入 FIFO → 写入文件 → 返回 `{success: true, bytesWritten: 256}`

#### Scenario: 角色越权被拒

- **WHEN** engineer 调 `task_write(taskId, path='plan/task-plan.md', content='...')`
- **THEN** task-process 拒绝,返回 `{success: false, reason: 'permission denied: engineer cannot write to plan/'}`

#### Scenario: 并发写同一文件

- **WHEN** 两个 engineer 同时调 `task_write` 写 `eng/design.md`
- **THEN** FIFO 队列串行执行:第一个成功写入,第二个排队等第一个完成后再执行(若 overwrite=false 且文件已存在则第二个被拒)

### Requirement: context_log hook 自动上报

`context_log(taskId, agentId, action, ref, ts)` SHALL 由 agent 的 PreToolUse/PostToolUse hook 自动调用(`at-hook` 二进制 POST 给 server 内部 endpoint,再转发到 chatroom-mcp 模块),agent 自身不主动调。`action` 枚举 `read-file / websearch / webfetch / run-cmd / mcp-call / skill-load`。

#### Scenario: agent 读文件触发 log

- **WHEN** agent 用 Read 工具读 `pm-ux/acceptance.md`
- **THEN** PostToolUse hook 触发 `at-hook` 二进制,POST 含 `action='read-file'`、`ref='pm-ux/acceptance.md'` 的 JSON 到 server;server 写入 SQLite `context_access_log` 表,前端 dashboard tab 实时刷新

### Requirement: chatroom-mcp 持久化与并发

chatroom-mcp 模块 MUST 用 SQLite WAL 模式存元数据(消息索引 / 状态 / seats / dashboard),消息原文 append-only 落 `chatroom.jsonl`(便于事后审计);状态转移用乐观锁(version 字段),并发冲突时失败重试。

#### Scenario: 并发写消息

- **WHEN** 两个 agent 同时调 `chatroom_send`
- **THEN** SQLite WAL 序列化两次写,`chatroom.jsonl` append 两条记录,返回各自的 `messageId`,无丢失

#### Scenario: 状态转移并发

- **WHEN** 两个 propose 同时到达 orchestrator
- **THEN** 乐观锁判定:其中一个成功,另一个返回 `{accepted: false, reason: 'version conflict, retry'}` 由 agent 自行重试

### Requirement: WebSocket 推送前端

server 的 WS 层 MUST 把所有 chatroom 事件(消息 / phase-change / seat 状态变化 / artifact-event / propose-rejected)透传给已连接的前端 client;前端只通过 WS 接收事件,不直接调 MCP。

#### Scenario: 前端实时看消息

- **WHEN** agent 调 `chatroom_send`
- **THEN** WS 立即把消息 broadcast 给该 task chatroom 的所有前端订阅者(单用户场景下通常 1 个 tab,但允许多 tab)

### Requirement: Bootstrap 状态事件

系统 SHALL 将 bootstrap resource 状态变化作为 chatroom system-event 和 WebSocket 事件广播给前端。事件 MUST 包含 taskId、resource id、kind、status、provider、mode 和可选摘要/错误。

#### Scenario: Bootstrap ready 广播

- **WHEN** bootstrap provider 将 primary worktree resource 更新为 ready
- **THEN** chatroom MUST 写入一条 system-event
- **AND** server MUST 通过 WS 向该 task 页面广播 bootstrap/resource 状态更新

#### Scenario: Bootstrap failed 广播

- **WHEN** bootstrap provider 将 resource 更新为 failed
- **THEN** chatroom MUST 写入包含失败摘要的 system-event
- **AND** 前端 MUST 能展示 failed 状态与 retry 入口


### Requirement: mention 唤醒 idle agent

`chatroom_send` 的 mention 处理 SHALL 在被 @ 的 seat 处于 `idle` 时也唤醒该 agent(promptSession 重新激活),不再仅对 `offline/vacant` 入队。这是 peer 催单闭环与 idle-trap 自愈的前提:被阻塞方 @ 上游催单后,上游即便已 idle 也能被唤醒响应。

唤醒分支:
- `vacant`:**仅入队,不 spawn**。懒式从未上场的 seat 被 @ 不提前拉起(否则会在错误阶段把 qa/ci 拉起来),等其阶段正常 spawn 时从 chatroom 消费这条 mention。
- `offline`:入队 + emit wakeup-seat(agent 曾在线后断连,re-spawn 唤醒是正当的)
- `idle`:唤醒(promptSession,内容引导其看 main 频道最新消息)
- `working`:不打断(turn 结束自然可见新消息)

#### Scenario: @ idle 的上游被唤醒

- **WHEN** qa `chatroom_send` mention engineer,engineer seat 当前 `idle`
- **THEN** 系统 MUST 唤醒 engineer agent 处理该 mention
- **AND** MUST NOT 仅把消息入队等永不到来的唤醒

#### Scenario: @ vacant 懒式 seat 不提前 spawn

- **WHEN** mention 的 seat 当前 `vacant`(懒式,尚未到其活跃阶段)
- **THEN** 系统 MUST 仅把消息入队,MUST NOT 提前 spawn 该 seat
- **AND** 该 seat 在其活跃阶段被正常 spawn 后 MUST 能从 chatroom 看到该 mention

#### Scenario: @ working 的 agent 不打断

- **WHEN** mention 的 seat 当前 `working`(turn 进行中)
- **THEN** 系统 MUST NOT 中断其当前 turn
- **AND** 该 agent 在当前 turn 结束后 MUST 能从 chatroom 看到该 mention

### Requirement: presence 经 WS 订阅快照 + 增量下发,不经 REST

前端获取 seat presence SHALL 仅通过活 task-process 的 WS 通道:订阅 task 时下发**全 seat presence 快照**,presence 变化时下发增量。REST `GET /tasks/:id/seats` SHALL 只返回岗位事实(`id / factory / role`),MUST NOT 含 presence。

#### Scenario: 订阅即收 presence 快照

- **WHEN** 前端 WS 订阅一个 task(进程在线)
- **THEN** 活进程 SHALL 回一份当前全 seat 的 presence 快照
- **AND** 后续每次 presence 变化推增量(`seat-state` 事件)

#### Scenario: GET /seats 不含 presence

- **WHEN** 前端 `GET /tasks/:id/seats`
- **THEN** 返回每个 seat 的 `{ id, factory, role }`
- **AND** 响应 MUST NOT 含 `status` 作为权威在场态(presence 走 WS)

### Requirement: 进程在线状态作为一等信号下发

WS SHALL 向订阅方告知该 task 的 `processAlive`(进程是否在线):订阅 ack 中携带,且在线状态变化时推送。前端据此在 `processAlive=false` 时把该 task 所有 seat 渲染为 `offline`。

#### Scenario: 进程下线推送离线

- **GIVEN** 前端正订阅某 task
- **WHEN** 该 task 的 task-process 心跳判定死亡
- **THEN** WS SHALL 推送 `processAlive=false`
- **AND** 前端 SHALL 据此将该 task 所有 seat 渲染为 `offline`,不沿用陈旧 presence
