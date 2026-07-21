# agent-runtime Specification

## Purpose
TBD - created by archiving change m1-skeleton. Update Purpose after archive.
## Requirements
### Requirement: agent 实例统一 alwaysOn lifecycle

所有工厂的 agent 实例 SHALL 使用统一 `lifecycle = alwaysOn`:S2 招满后全程在线,非工作阶段保持 `idle`(长时 idle 后 SIGSTOP),**只在 task done(S11 propose 通过)或 agent crash 时才释放**。

#### Scenario: agent 跨态保持在线

- **WHEN** task 处于 S6,planner 已无工作只 idle
- **THEN** planner 进程保留,但被 SIGSTOP 暂停(CPU 0,内存留);后端 SIGCONT 唤醒条件:收到 mention / phase-change / 人类 @

#### Scenario: task done 统一释放

- **WHEN** planner 调 `task_state_propose(taskId, 'done', evidence=[retro.md])` 校验通过
- **THEN** orchestrator 对该 task 所有 agent 发 SIGTERM(30s 不退则 SIGKILL),归档每个 agent 的 `factory.lock.yaml` + skill diff 到 `<task-workdir>/retro/agent-<id>-snapshot/`,task agents 进入 `terminated` 状态;agents/ 目录不删,作为归档保留

### Requirement: 信息共享与隔离模型

系统 SHALL 遵循"**共享是默认,隔离是例外**"的运行时信息模型:只有必须隔离的内容才放进 agent workspace,其余一律通过 chatroom 共享。

**信息层(via Chatroom)**:task 信息(plan / artifact / phase 通知 / seat 状态)全部通过 chatroom MCP tools 共享给所有 agent。Agent 不需要自己存副本——通过 `artifact_get` / `chatroom_recent` 按需读取。

| 类别 | 可见范围 | 内容 |
|---|---|---|
| 全局共享 | all seats | main channel 消息、task state 变更、artifact 注册事件、seat 状态 |
| 角色频道 | 同角色 | eng-internal(仅 engineers),未来 qa-internal 等 |
| 私有 | 仅自己 | agent notes.md、ACP session 上下文 |

**文件层 — 三种写入模式**:

| 区域 | 写入方式 | 协调机制 |
|---|---|---|
| `agents/<id>/` | 直接写 | 无(排他) |
| `worktree/` | 直接写 | 无(planner 预编排任务分工) |
| `plan/`, `eng/`, `retro/` 等 | `task_write` MCP tool | FIFO 队列 + 角色校验 |
| `chatroom.jsonl`, `state.json` | 系统内部 | agent 不可写 |

#### Scenario: agent 读取共享信息

- **WHEN** engineer 需要了解 task plan 内容
- **THEN** engineer 调 `artifact_get(taskPlanId)` 或 `chatroom_recent(channel='main')` 读取,不需要从 workspace 本地文件获取

#### Scenario: agent 写 artifact 目录

- **WHEN** engineer 需要写 `eng/test-report.md`
- **THEN** engineer 调 `task_write(taskId, 'eng/test-report.md', content, overwrite=true)`,task-process 校验角色 + FIFO 串行写入;禁止直接文件写入

#### Scenario: agent 写私有草稿

- **WHEN** agent 需要记录中间思考
- **THEN** agent 直接写 `agents/<id>/notes.md`,无需走 MCP tool

### Requirement: task 内独立 workspace

每个 agent 实例 MUST 拥有独立 workspace 落在 `<task-workdir>/agents/<agent-id>/`(`agent-id` 命名 `<factory>-<task-short>-<n>`),**只放必须隔离的内容**:`.claude/{settings.json, skills/}` + `mcp.json` + `notes.md` + `factory.lock.yaml`。Workspace 是"task 的成员",task abort/done 时一并归档或清理。

#### Scenario: spawn 时建 workspace

- **WHEN** orchestrator 触发 spawn 流程
- **THEN** 创建 `<task-workdir>/agents/<agent-id>/.claude/skills/`,工厂 `recommendedSkills` 中每个 skill 用 `ln -s ~/.claude/skills/<skill>` 软链过来;若 macOS 软链不被 Claude Code follow,fallback 用 `rsync -a` copy

#### Scenario: 运行时新装 skill 不污染全局

- **WHEN** agent 运行时通过 skill-creator 等机制装新 skill
- **THEN** 新 skill 落在 `<task-workdir>/agents/<agent-id>/.claude/skills/<new-skill>/`,不影响 `~/.claude/skills/`

### Requirement: ACP driving + 配置注入

agent 子进程 SHALL 通过 **Agent Client Protocol (ACP)** 驱动(用 `@zed-industries/claude-code-acp` bridge,bin `claude-code-acp`,内嵌 Agent SDK),`session/new` + `session/prompt` + `session/update` 流式;同时 MUST 注入 mcp/hooks/skill/system prompt(与 ACP 驱动正交)。**注入的具体机制(ACP session 参数 vs Agent SDK options vs CLI flag)由 Phase 0 spike 实测确定后固化**;无论机制如何,MUST 保证 agent workspace 优先 + 显式 mcp 配置路径,落实 CVE-2025-59536 路径锁定。

#### Scenario: spawn 与配置注入

- **WHEN** orchestrator spawn 一个 agent
- **THEN** 启动 provider adapter 并创建 agent session
- **AND** `cwd` MUST 为 agent workspace(优先,权限锁定)
- **AND** `mcpServers` MUST 包含 chatroom-mcp + 工厂 recommendedMcps + task 注入
- **AND** 若存在 ready worktree task resource,`additionalDirectories` MUST 包含该 worktree path 及其必要 gitdir/commondir
- **AND** 若 worktree resource 不存在或未 ready,orchestrator MUST NOT 把空目录作为 ready worktree 注入

#### Scenario: ACP session 启动

- **WHEN** provider bridge 进程 ready 且 SDK 鉴权通过
- **THEN** 后端通过 provider adapter 创建 session,订阅 update 流式事件,并通过 `session/prompt(initialMessage)` 触发首轮对话

### Requirement: per-task subprocess 形态(D)

系统 SHALL 采用"主 server + 每 task 一进程"的部署形态:主 server 进程常驻管理 web/WS/元数据,每个活跃 task 通过 `child_process.fork()` 派生一个 task-process,task-process 内含 chatroom-mcp 模块 + orchestrator + 该 task 的全部 agent 子进程。task 间 crash 隔离,主 server 永不被任务级错误带崩。

#### Scenario: 任务启动派生 subprocess

- **WHEN** 用户创建 task 并 S0 → S1
- **THEN** 主 server 派生一个 task-process(`child_process.fork`),传入 task-id 和必要配置;task-process 启动该 task 的 chatroom-mcp 模块 + orchestrator,并准备 spawn agents

#### Scenario: 某 task crash 不影响其他

- **WHEN** 某 task-process 异常崩溃
- **THEN** 主 server 通过 Node IPC 心跳检测到,标记该 task 为 `process-crashed`,通过桌面 Notification 告警人类;其他 task-process + 主 server 不受影响

### Requirement: 主 server ↔ task-process IPC

主 server 与 task-process 之间 SHALL 通过 Node IPC(`process.send` / `process.on('message')`)双向通信,消息类型至少包含:`task-event`(task-process → server:消息发出 / phase-change / artifact-event,server 转 WS 推前端)、`user-input`(server → task-process:人类发消息 / @ 路由 / 控制指令如 pause/resume/abort)、`heartbeat`(双向)。

#### Scenario: 前端发消息

- **WHEN** 前端通过 WS 发"人类消息"给某 task
- **THEN** 主 server 路由该消息为 `user-input` 通过 IPC 转发给对应 task-process;task-process 内的 chatroom-mcp 模块写入 chatroom 并推给目标 agent

### Requirement: agent displayName 历史人物抽签

每个 agent 实例 MUST 在 spawn 时从所属工厂的 `defaultNamePool` 中无重复抽签一个中国历史人物名作为 `displayName`(如 planner=诸葛亮 / engineer=墨子 / qa=包拯)。crash 重 spawn 时**重新抽签**(因为是新实例新人接班),不复用旧名。

#### Scenario: 并发同工厂多实例

- **WHEN** 同一 task 招 2 个 engineer
- **THEN** 第一个抽到"墨子",第二个从剩余池抽"沈括"(不重复)

#### Scenario: crash 重 spawn

- **WHEN** "墨子" engineer crash
- **THEN** orchestrator 标记原 agent terminated,从剩余池抽新名(如"张衡")spawn,chatroom 显示新岗位 chip 是"张衡"

### Requirement: factory.lock.yaml 快照

每个 agent spawn 时 MUST 把当时使用的工厂版本 + 完整配置(persona / systemPromptTemplate / 所有 recommended* / coreMcps / defaultPermissions / workingHabits / deliverables)+ 抽签的 displayName 快照写到 workspace 的 `factory.lock.yaml`。task done 时归档到 `retro/agent-<id>-snapshot/factory.lock.yaml`,复盘可见。

#### Scenario: 复盘看快照

- **WHEN** task 归档后,复盘视图加载某 agent 详情
- **THEN** 前端能看到该 agent 用的是工厂哪个版本,以及与当前最新工厂模板的 diff(显示"装了什么 skill 是工厂模板没有的"等)

### Requirement: 软链 vs Copy 实测策略

M1 阶段 spawn 流程对 skill **优先用软链**(`ln -s`),启动后 MUST 通过一个简单"skill 可见性检查"探针验证 Claude Code 是否能正确识别。若软链不被识别,SHALL fallback 改用 `rsync -a` 拷贝 + 工厂版本号判定是否需要重 copy。

#### Scenario: 软链可见

- **WHEN** spawn 后探针调 `claude --list-skills` 返回值包含 workspace 软链的 skill 名
- **THEN** 标记"软链 OK",继续 spawn 流程

#### Scenario: 软链不可见 fallback copy

- **WHEN** 探针发现软链 skill 不可见
- **THEN** 删除软链改用 `rsync -a` 拷贝全部目标 skill 到 workspace,记日志 `WARN: symlink not followed, fell back to copy`

### Requirement: 进程池容量与心跳

主 server MUST 维护 task-process 池(默认上限可配,M1 设 2 个并发 task 验证链路,生产目标 20),每个 task-process 内的 agent 子进程数无硬限(由 seatPlan 决定);超过上限的新 task SHALL 排队。主 server MUST 每 30s 对每个 task-process 心跳;3 次未响应视为僵死,强杀该 task-process 并告警。

#### Scenario: 超过并发上限

- **WHEN** 已有 2 个活跃 task(M1 上限),用户尝试创建第 3 个
- **THEN** 主 server 拒绝创建,前端显示"已达并发上限,请先归档或 abort 其他任务"

#### Scenario: 心跳异常

- **WHEN** task-process 连续 3 次心跳未响应
- **THEN** 主 server 发 SIGKILL,标记该 task 为 `process-crashed`,通过 Notification 告警人类决策(重启该 task / abort)

### Requirement: Agent 消费 task bootstrap resource

Agent runtime SHALL 将 task bootstrap resource 作为 task 级上下文注入给 agent。Planner 可以在 bootstrap creating/failed/disabled 时启动；engineer/qa/ci 若需要代码工作区则必须看到 ready worktree resource。

#### Scenario: Planner 不等待 worktree

- **WHEN** task 创建后 planner 初始化完成但 bootstrap 仍在 creating
- **THEN** planner MUST 能读取 bootstrap status 并继续进行需求对齐
- **AND** planner prompt MUST NOT 声称 worktree 已 ready

#### Scenario: Engineer 使用 ready worktree

- **WHEN** engineer 被招募且 primary worktree resource 为 ready
- **THEN** engineer prompt MUST 包含 worktree path、branch、mode、provider 摘要
- **AND** engineer session 的 allowed/additional directory MUST 指向该 ready resource path

### Requirement: Planner 不拥有 bootstrap 职责

Planner factory 的 recommended skills SHALL NOT 包含仅用于 task bootstrap 的 `sw`。Bootstrap provider 可以复用 `sw` 的程序入口或脚本，但它属于 orchestrator/task resource 层。

#### Scenario: Planner skills 不含 sw

- **WHEN** planner agent workspace 初始化 skills
- **THEN** `sw` MUST NOT 因 task bootstrap 职责被注入为 planner recommended skill
- **AND** planner 如需了解 worktree 状态 MUST 通过 task resource 查询而不是调用 `sw`


### Requirement: 统一 wake 原语

系统 SHALL 提供单一 `wake(seat, prompt)` 原语,作为所有"激活 agent 干活"路径的唯一入口:进态驱动唤醒、mention 唤醒、人类发言唤醒、spawn 首发。`wake` MUST 按 seat 状态分派:vacant→懒 spawn(首 prompt 即生效)、idle→promptSession、working→排队不打断。各调用方 MUST NOT 各自直接散调 promptSession / spawn(消除散落的 promptQa* / buildRetroPrompt / recruit-spawn 定制函数)。

#### Scenario: wake 对 vacant 懒 spawn

- **WHEN** wake 一个 vacant seat
- **THEN** MUST spawn 该 seat 的 agent,并把 prompt 作为首轮输入
- **AND** MUST NOT 报"无 session"错误

#### Scenario: wake 对 idle 重激活

- **WHEN** wake 一个 idle seat(agent 进程在、turn 已结束)
- **THEN** MUST promptSession 重新激活该 agent

### Requirement: idle-entry 生产力检查 hook

agent turn 结束(adapter done → markAgentIdle)时,若该 agent 是当前 task state 的 driver,系统 SHALL 执行生产力检查(见 task-lifecycle "idle-entry 生产力 hook"):无进展则软推(上限 2 次/phase),超限升级。该 hook MUST 挂在 runtime adapter 的 done 事件上,对 claude-acp 与 codex-sdk/exec 等所有 provider 一致生效。

#### Scenario: 跨 provider 一致

- **WHEN** 一个 codex-sdk agent 与一个 claude-acp agent 都在各自活跃阶段空转一轮
- **THEN** 两者 MUST 都触发 idle-entry 软推(hook 与 provider 无关)

### Requirement: Presence 为纯派生、非持久化状态

Agent/seat 的在场态(presence)SHALL 由活 task-process 从其 in-memory session map 派生,MUST NOT 作为权威状态持久化进 DB。Presence 取值为 `vacant | spawning | working | idle | offline`。

DB 中 seat 行 SHALL 只持久化岗位事实 `{ id, taskId, factory, role }`;`seats.status` / `agents.state` MUST NOT 被任何业务逻辑当作"此刻在场态"的事实来源读取。

#### Scenario: presence 从 session map 派生

- **GIVEN** 一个 seat 绑定了 agent A
- **WHEN** 计算该 seat 的 presence
- **THEN** 进程内有 A 的 live session 且当前 turn 在跑 → `working`
- **AND** 有 live session 但无 turn → `idle`
- **AND** 无 live session(从未 spawn / 上个进程已死)→ `vacant`
- **AND** spawn 进行中 → `spawning`

#### Scenario: presence 不落库

- **WHEN** seat 的 presence 变化
- **THEN** 活进程派生新值并经 WS 广播
- **AND** MUST NOT 写入 DB 作为权威(DB 无 presence 列被读为真相)

### Requirement: 进程不在线时 presence 显式为 offline

当某 task 的 task-process 不在线(心跳判定 / `launcher.hasActive` 为 false)时,该 task 所有 seat 的 presence SHALL 显式为 `offline`,前端 MUST NOT 显示该进程上次的 `working`/`idle` 等陈旧在场态。

#### Scenario: 进程死 → 诚实离线

- **GIVEN** 一个 task 的 agent 此前显示 `working`
- **WHEN** 该 task 的 task-process 被杀 / crash
- **THEN** 前端 SHALL 渲染该 task 所有 seat 为 `offline`
- **AND** MUST NOT 继续显示 `working`(僵尸态在定义上不可能出现)

#### Scenario: 正确性不依赖进程包活

- **WHEN** task-process 死亡
- **THEN** 系统正确性 SHALL 仅依赖"诚实离线"
- **AND** 进程自动救活 / 包活 MAY 缺席,不影响状态一致性

### Requirement: 后端在场判定读 session map 而非 DB

`wake` 原语及编排判定(driver 唤醒 / S2 gate / idle 检查)SHALL 以活进程的 session map 为在场事实来源;MUST NOT 依赖持久化的 `seat.status`。

#### Scenario: wake 按真实 session 决策

- **WHEN** wake 一个 seat(含 relaunch 后绑定 agent 已死的情况)
- **THEN** 进程内无该 seat 当前 agent 的 live session → 重新 spawn
- **AND** 有 live session → promptSession 重激活
- **AND** 判定 MUST NOT 因 DB `seat.status` 与真实进程漂移而误判(如对死 session 静默失败)
