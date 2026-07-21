# task-lifecycle Specification

## Purpose
TBD - created by archiving change m1-skeleton. Update Purpose after archive.
## Requirements
### Requirement: 任务首页表单创建任务 (S0)

系统 SHALL 允许单用户在 web 首页填写任务描述与可选上下文链接，并通过 "开始" 按钮触发任务创建。系统 MUST 校验描述非空才允许提交；标题可由 server 从描述推断。任务创建时系统 MUST 创建 task 管理目录、初始化 chatroom、创建 planner seat，并按项目默认 bootstrap 配置并行启动 bootstrap。Worktree 准备不属于 planner 职责。

#### Scenario: 用户填表并开始

- **WHEN** 用户填写描述(非空)和可选上下文链接,然后点击 "开始"
- **THEN** 系统生成 task-id,在 `~/.agent-team/projects/<project>/tasks/<task-id>/` 创建 task 管理目录骨架
- **AND** 系统 MUST 初始化 chatroom,预创建 `planner` 岗位,并把表单内容作为初始 `human-msg` 喂入 chatroom
- **AND** 系统 MUST 并行启动 planner 初始化与默认 bootstrap provider
- **AND** 系统 MUST NOT 要求 planner 调 `sw` 或任何 bootstrap skill 来创建 worktree

#### Scenario: 描述为空被拒绝

- **WHEN** 用户未填写描述就点击 "开始"
- **THEN** 系统拒绝创建,前端在表单上显示描述不能为空,task 目录不创建

#### Scenario: Bootstrap 失败不阻塞 planner 对齐

- **WHEN** task 创建后 bootstrap provider 创建 worktree 失败
- **THEN** planner 仍 MUST 能进入 S1 并通过 chatroom 与用户对齐
- **AND** 任务 MUST 显示 bootstrap failed 状态并允许 retry
- **AND** 系统 MUST NOT 将空 `worktree/` 目录描述为可用隔离分支

### Requirement: planner 规划阶段 (S1)

系统 MUST 在 task 创建后立即从 `planner` 工厂招募一个实例(`alwaysOn` lifecycle),planner SHALL 通过 chatroom 与用户多轮对话,产出 `plan/task-plan.md`(含 seatPlan 岗位清单 + anti R1 开关 + 子任务依赖图 + 验收锚点)。

#### Scenario: planner 入场 context echo

- **WHEN** planner 实例 spawn 完成且收到第一条 human-msg
- **THEN** planner 必须在 chatroom 发出固定格式开场消息:"📋 任务理解 + 已知信息 + 需澄清问题",等待用户对齐;**禁止脑补**

#### Scenario: planner 完成规划提议进入 S2

- **WHEN** planner 完成 `plan/task-plan.md` 并 调用 `task_state_propose(taskId, 'S2', evidence=[task-plan.md])`
- **THEN** orchestrator 经三层校验(文件存在 + schema + 内容 lint)通过后推进状态到 S2,广播 `phase-change` 事件给所有 chatroom 订阅者

### Requirement: 招募阶段 (S2)

系统 MUST 在 S2 入态时按 `seatPlan` 一次招满所有岗位(planner 已在 S1 招过,这里补齐其余),每个 agent 拥有独立 workspace 与 `displayName`(从工厂 `defaultNamePool` 无重复抽签),全部 agent `state == idle` 后自动推进到下一态。

#### Scenario: 一次招满

- **WHEN** S2 入态
- **THEN** orchestrator 对 seatPlan 中每个岗位执行 spawn 流程(建 workspace + 软链 skill + 写 mcp.json + 写 settings.json + 渲染 system prompt + ACP 启动);所有 agent `state == idle` 后,orchestrator 自动 propose 进入 S6(M1 跳过 S3/S4/S5)

#### Scenario: spawn 失败重试

- **WHEN** 任一 agent spawn 失败
- **THEN** orchestrator 重试 3 次;仍失败则在 chatroom 发 `system-event: spawn-failed` + 通过桌面 Notification 告警人类;任务暂停在 S2

### Requirement: engineer 实现阶段 (S6)

engineer 实例 SHALL 在 S6 阶段对照 task-plan 完成代码实现,每个子任务完成 commit 一次,本地跑通 unit test + e2e 后通过 `task_state_propose(S6 → S10')` 自报完成。

#### Scenario: engineer 完成实现

- **WHEN** engineer 完成所有改动 + 本地测试通过 + 调用 `task_state_propose(taskId, "S10'", evidence=[eng/test-report.md])`
- **THEN** orchestrator 校验 `eng/test-report.md` 存在且 schema 符合(含测试通过结果)后,推进到 S10'(M1 简化版"等人类")

#### Scenario: 测试失败不放行

- **WHEN** engineer 本地测试失败但仍尝试 propose
- **THEN** orchestrator 校验 `eng/test-report.md` 内容时发现失败标记,拒绝 propose,在 chatroom 发 `system-event: propose-rejected, reason: 测试未全过`

### Requirement: 复盘阶段 (S11)

系统 MUST 在人类确认完成后进入 releasing 收尾阶段。Releasing 阶段 agents MUST 保持在线，planner SHALL 读取完整 chatroom transcript、artifact、状态机轨迹和 task resources，产出 `retro/retrospective.md` 与 `retro/archive-plan.md`。Orchestrator MUST 在 resource release 进入安全终态后才释放 agents 并标记 task 为 done。

#### Scenario: 人类确认完成进入 releasing

- **WHEN** task 处于 S10' 或等人类确认状态,且用户点击完成
- **THEN** task MUST 进入 `releasing` 状态
- **AND** orchestrator MUST 唤醒 planner 执行复盘与 archive/release plan
- **AND** orchestrator MUST NOT 在进入 releasing 时立即 kill agents

#### Scenario: planner 完成收尾后 done

- **WHEN** planner 完成 `retro/retrospective.md` 和 `retro/archive-plan.md`
- **AND** task resources 已进入 `retained`、`removed`、`archived` 或 `needs-review` 等明确终态
- **THEN** orchestrator MUST 释放所有 agent sessions、归档 agent workspace 快照,并将 task 标记为 `done`

#### Scenario: 收尾需要 agent 协助

- **WHEN** planner 在 releasing 阶段需要确认 engineer/qa/ci 的上下文
- **THEN** planner MUST 能继续 @ 这些仍在线的 agents
- **AND** 被 @ agent MUST 能读取 chatroom/artifacts 并回复

#### Scenario: Resource release 不确定

- **WHEN** worktree release provider 无法证明 worktree 可安全删除
- **THEN** orchestrator MUST 将该 resource 标记为 `retained` 或 `needs-review`
- **AND** 该状态 MUST 记录在 `retro/archive-plan.md`
- **AND** 如果 retained/needs-review 是明确终态,task MAY 继续进入 done

### Requirement: propose 三层校验

orchestrator 在收到 `task_state_propose` 时 MUST 依次执行三层校验,任一层失败则拒绝并在 chatroom 发 `system-event: propose-rejected, reason: <哪条没过>`,允许 agent retry。

- Layer 1(硬,规则): 工厂 `deliverables` 中所有必交付物路径存在且非空
- Layer 2(硬,规则): 每个 artifact 类型的 markdown AST 通过 schema 检查(关键 section 不缺)
- Layer 3(软,可选,LLM):工厂可配置 `contentLint=true` 时,用小 LLM 检查内容是否真正符合产出契约,低 confidence 给警告但不阻塞

#### Scenario: 文件缺失被拒

- **WHEN** agent 调 `task_state_propose` 但工厂 deliverables 中某文件不存在
- **THEN** orchestrator 拒绝,reason 类似 `"task-plan.md not found at plan/task-plan.md"`

#### Scenario: schema 不符被拒

- **WHEN** artifact 文件存在但缺关键 section(如 `design.md` 缺 `## 改动文件清单`)
- **THEN** orchestrator 拒绝,reason 形如 `"design.md missing required section '改动文件清单'"`

### Requirement: 暂停 / 恢复 / abort

系统 SHALL 支持用户随时暂停 / 恢复 / abort 任务,且必须保证 agent 进程与 task 数据状态一致。

#### Scenario: 用户暂停

- **WHEN** 用户在前端点 "暂停" 按钮
- **THEN** orchestrator 广播 `system-event: pause`,所有 agent 完成当前消息后进入 `state == idle`(进程不杀,transcript 保留);桌面通知"已暂停"

#### Scenario: 用户 abort

- **WHEN** 用户点 "abort"
- **THEN** orchestrator 对所有 agent 发 SIGTERM(30s 不退则 SIGKILL),task 标记 `aborted`,目录保留但跳过复盘

### Requirement: agent crash 自动重 spawn

当 agent 进程异常退出(非 SIGTERM/SIGKILL),系统 MUST 自动从工厂模板重 spawn 一个新实例(新 agent-id,displayName 重新抽签),并通过 `chatroom_recent` + `artifact_list` 让新实例重建上下文,不沿用 crash 实例的 transcript。

#### Scenario: agent 崩溃

- **WHEN** 某 agent 进程异常退出
- **THEN** orchestrator 标记原 agent `state=terminated`,岗位 `working/idle → vacant`,归档 crash 时刻快照,然后用工厂模板 spawn 新实例,岗位恢复到 `init → idle`,新 agent 通过工具拉历史上下文继续工作

### Requirement: M1 状态机覆盖 5 态 + 1 简化态

M1 阶段 SHALL 实现 5 个正式态 + 1 简化态:`S0 任务首页`、`S1 规划`、`S2 招募`、`S6 实现`、`S10' 等人类`(简化版,跳过 S3/S4/S5/S7/S8/S9)、`S11 复盘`。其余 7 态(S3 pm-ux / S4 eng 设计 / S5 anti R1 / S7 qa / S8 anti R2 / S9 ci / S10 完整等)留待 M2/M3 milestone 引入。

#### Scenario: 跳过 S3-S5 直接 S6

- **WHEN** S2 招满全员且 engineer `state == idle`
- **THEN** orchestrator 自动 propose `S2 → S6`(M1 简化,因 pm-ux/anti 工厂未实现)

#### Scenario: 跳过 S7-S9 直接 S10'

- **WHEN** engineer 在 S6 完成 propose
- **THEN** orchestrator 校验 `eng/test-report.md` 后直接进 S10'(M1 简化,因 qa/anti/ci 工厂未实现)

### Requirement: S7 qa 验收态

状态机 SHALL 包含正式的 S7 qa 验收态。engineer 在 S6 完成实现后 MUST 经 propose 进入 S7;qa 在 S7 做发现式验收。S7 通过(全锚点 PASS)MUST 推进后续态;S7 失败(任一 FAIL)MUST 回到 engineer repair 后重新进入 S7 复验。qa 在 S7 的 deliverable MUST 为 `qa/verification_report.md`(含逐条锚点结论 + 证据)。

#### Scenario: engineer 完成 → 进 S7
- **WHEN** engineer 在 S6 完成实现并 propose 完成
- **THEN** 状态机 MUST 进入 S7 qa 验收态
- **AND** qa MUST 在 S7 开始发现式验收

#### Scenario: S7 通过推进
- **WHEN** qa 在 S7 的 `qa/verification_report.md` 全部锚点结论为 PASS
- **THEN** 状态机 MUST 允许推进到后续态(收尾/复盘)

#### Scenario: S7 失败回 repair
- **WHEN** qa 在 S7 的报告含任一 FAIL 项
- **THEN** 状态机 MUST 支持回到 engineer repair,修复后重新进入 S7 复验
- **AND** propose 进入 S7 后续态 MUST 要求 `qa/verification_report.md` 存在且无 FAIL 结论

### Requirement: S9 ci 监控态
状态机 SHALL 包含正式的 S9 ci 监控态。qa 在 S7 全锚点 PASS 后,**若 task 含 ci seat**,MUST 经 propose 进入 S9(替代 S7→S10');ci 在 S9 执行 MR 创建 / CI 轮询 / comment 路由 / ready2merge 上报。S9 通过(`ci/ci_report.md` 含 `ready2merge: true`)MUST 推进到 S10'(等人类合 MR + 桌面通知)。

ci 不在场时,m2-qa-role 引入的兼容路径 `S7→S10'`(`qa-propose-S10`)MUST 仍可用,避免强依赖 ci seat。

#### Scenario: qa PASS + ci 在场 → 进 S9
- **WHEN** qa 在 S7 完成全锚点 PASS 且 task 含 factory=`ci` 的 seat
- **THEN** 状态机 MUST 支持从 S7 经 `qa-propose-S9` 转移进 S9
- **AND** ci agent MUST 在 S9 开始 MR/CI 监控工作

#### Scenario: qa PASS + ci 不在场 → 兼容回 S10'
- **WHEN** qa 在 S7 完成全锚点 PASS 且 task **不含** factory=`ci` 的 seat
- **THEN** 状态机 MUST 仍支持 `qa-propose-S10` 从 S7→S10'(m2-qa-role 引入的兼容路径)
- **AND** 不要求 ci 出场

#### Scenario: S9 通过 → 推进到 S10'
- **WHEN** ci 在 S9 完成 MR/CI 流程且 `ci/ci_report.md` 含 `ready2merge: true`
- **THEN** 状态机 MUST 允许 ci 经 `ci-propose-ready2merge` 推进到 S10'
- **AND** propose 进入 S10' 的 L2c 校验 MUST 通过(report 含 `ready2merge: true` 标记)
- **AND** 进 S10' 后桌面通知 hook MUST 被触发

#### Scenario: ci 报告缺 ready2merge → propose 被拒
- **WHEN** ci 尝试 `task_state_propose(taskId, "S10'", evidence)` 但 `ci/ci_report.md` 不含 `ready2merge: true`
- **THEN** propose-handler 的 L2c 校验 MUST 拒绝该转移
- **AND** 返回错误必须明确指出 ready2merge 标记缺失

### Requirement: Engineer 招募依赖 worktree ready

系统 SHALL 在需要代码实现或验证的岗位启动前检查 ready worktree resource。若 task bootstrap 被禁用或 worktree 未 ready，系统 MUST 明确告知 planner/用户，并阻止 engineer 在空目录中工作。

#### Scenario: Worktree creating 时进入 S2

- **WHEN** planner propose 进入 S2 且需要招募 engineer
- **AND** primary worktree resource 仍为 `creating`
- **THEN** orchestrator MUST 等待 resource ready 或提示 worktree 未就绪
- **AND** engineer MUST NOT 被提示在空 `worktree/` 中实现代码

#### Scenario: No-worktree task 招募

- **WHEN** task bootstrap 被禁用且 planner 明确声明该 task 不需要代码 worktree
- **THEN** orchestrator MAY 允许仅文档/讨论型 seat 继续
- **AND** 任何需要代码写入的 factory MUST 被 gate 或要求先创建 worktree resource

### Requirement: ci factory S9 5 步流程

ci agent 在 S9 入态后 SHALL 执行固定的 5 步流程:

1. **Step 0 — skill 可达性 spike**(本任务首次进 S9 时执行):试调一个项目内 skill 的 noop 命令(如 `/deploy --help`)。若不可达,MUST 在 chatroom 报告"skill 不可达,请人类介入",不继续后续 step。
2. **Step 1 — 推 MR + 绑工单**:`git push` / `internal-cli git mr-create`。若 push hook 错误或 lint 失败,ci MUST NOT 自己 fix,MUST 用 `task_state_propose(S9→S6, evidence=[ci/push-error.md])` 回退 engineer。成功推送后写 `ci/ci_report.md` 包含 `mr: <url>` 和 `issue-tracker: <url 或 "none">`。工单 URL 缺失时 MUST `chatroom_send mention=@human` 询问"创建 ship-ticket / 提供现有 URL / 裸 MR 不绑"三选一。
3. **Step 2.1 — /local 启本地**:调 claude 内置 `/local` skill,启动 worktree 内的 dev server。完成后 task_write 追加 `本地 server: <url>`。
4. **Step 2.2 — /deploy staging 小流量**:**仅** task 关联 project 配置了部署 skill 时执行。完成后 task_write 追加 `staging 小流量: <url>`。无需部署的项目 MUST 跳过此 step 并写 `staging 小流量: skip-no-deploy`。
5. **Step 3 — /pm 自动巡检**:发送 1/2 汇总到 chatroom 后调 `/pm` skill。pm 自带结束条件(CI checks 全绿 + 无等待 + comment 全 resolved)。
6. **Step 4 — 收尾通知人类**:pm 结束后 chatroom_send urgent system-event "请人类点 done",task_write `ci/ci_report.md` 最后写 `ready2merge: true`,`task_state_propose(S9→S10', artifacts=[ci/ci_report.md])`。

每个 Step 开始时 ci agent MUST `chatroom_send` 发进度("step N 开始 / done")。

#### Scenario: ci 不动业务代码

- **WHEN** Step 1 推 MR 时遇 git push hook 报错 / lint failure
- **THEN** ci MUST NOT 调 task_write / Edit 改 worktree 代码
- **AND** ci MUST chatroom_send 详细错误 + `task_state_propose(S9→S6)` 回退 engineer
- **AND** engineer 修复后再走完整 S6→S7→S9 流程

#### Scenario: 无需部署的项目跳过 staging 部署

- **WHEN** task 关联 project 未配置部署 skill
- **THEN** ci Step 2.2 MUST 跳过 deploy 调用
- **AND** ci_report.md 中相应行 MUST 写 `staging 小流量: skip-no-deploy`
- **AND** 不影响后续 step 3/4 进行

### Requirement: engineer commit hash list evidence

engineer 在 S6→S7 propose 时 SHALL 在 evidence 列入 `eng/commits-<n>.txt`(n 为本任务内 repair 次数,首次为 1)。文件内容 MUST 是本轮 commit hash 列表,一行一个,最旧在前。propose-handler L2 校验 MUST 验证此文件存在。

#### Scenario: 首次 propose S6→S7

- **WHEN** engineer 第一次完成本任务实现并 propose S6→S7
- **THEN** evidence MUST 包含 `eng/test-report-1.md` 和 `eng/commits-1.txt`
- **AND** `eng/commits-1.txt` 第一行 MUST 是首个 commit hash

#### Scenario: 重复 propose(repair 后)

- **WHEN** engineer 在 qa fail 后修复并第 n 次 propose S6→S7(n>1)
- **THEN** evidence MUST 包含 `eng/commits-<n>.txt` 含本轮(自上一轮 propose 后)的所有 commit hash
- **AND** 上一轮的 `eng/commits-<n-1>.txt` MUST 仍保留(不覆盖)

### Requirement: qa 增量验收

qa 在 S7 入态时 SHALL 实施增量验收:基于本轮 commit diff 决定哪些 acceptance.md 锚点需要重新验证。

具体行为:

1. 读 `plan/acceptance.md` 中所有锚点(含每锚点的"影响范围"glob 列表)
2. 读 当前轮 `eng/commits-<n>.txt`
3. 若 n>1:读 `qa/verification_report-<n-1>.md`,提取上轮 PASS 锚点列表
4. 对每个上轮 PASS 锚点:用 `git show <hash>` 累加本轮 diff 涉及文件;若 diff 文件命中锚点"影响范围" → 重新验,否则沿用 PASS
5. 没 PASS 记录的(首轮 / 新加锚点)→ 全量验
6. 输出 `qa/verification_report-<n>.md`(每轮独立文件)

qa 在任意"判不准是否影响"时 MUST fall back 全量验证(宁可慢不能放过 bug)。每 N=3 轮 SHALL 强制全量一次(防长期增量积累误差)。

#### Scenario: 增量 — 上轮 PASS 锚点不在 diff 内

- **WHEN** 上轮 qa/verification_report-1.md 标 A1 PASS,本轮 commits diff 不含 A1 影响范围 glob
- **THEN** qa MUST 在新报告 qa/verification_report-2.md 中 A1 标 PASS 并注明"沿用上轮 (commit <hash>)"
- **AND** qa MUST NOT 重新跑 A1 验证(节省 token)

#### Scenario: 增量 — 上轮 PASS 锚点被 diff 影响

- **WHEN** 上轮 A2 PASS,本轮 commits diff 含 A2 影响范围 glob 匹配的文件
- **THEN** qa MUST 重新跑 A2 完整验证
- **AND** 结果记录在 qa/verification_report-<n>.md

#### Scenario: 强制全量(每 N 轮)

- **WHEN** n % 3 == 0(每第 3 轮)
- **THEN** qa MUST 全量验证所有锚点,不沿用任何上轮 PASS

### Requirement: qa report 多版本兼容

propose-handler L2 在校验 `qa/verification_report.md` 时 SHALL 兼容多版本文件名 `qa/verification_report-<n>.md`(n 为正整数)。校验逻辑:从 max(n) 倒序找第一个存在的版本,作为"当前轮 qa report"参与校验。

`eng/test-report.md` 和 `eng/commits.txt` 同理(多版本兼容)。

#### Scenario: 多轮场景下校验最新版本

- **WHEN** task 目录下存在 `qa/verification_report-1.md` 和 `qa/verification_report-2.md`,且 qa 刚 propose
- **THEN** L2 校验 MUST 用 verification_report-2.md(max n)做内容 schema 检查
- **AND** 校验 anchor `## 最终结论` 段存在于 verification_report-2.md


### Requirement: 进态驱动唤醒(声明式)

进入某状态时,系统 SHALL 自动唤醒"活跃于该状态"的角色的 seat。角色的活跃状态集 MUST 从 `factory.defaultPermissions.proposeTransitions` 的 `from` 状态派生(去重),不引入额外字段。唤醒规则:

- seat `vacant`(或无 currentAgentId)→ 懒 spawn agent,spawn 首 prompt 即生效
- seat `idle` → promptSession 重新激活
- seat `working` → 不打断(promptSession 排队,turn 结束消费)

唤醒内容 MUST 是与角色无关的通用文本(轮到你 + 自检输入就绪 + 没就绪就催不要静默),具体阶段职责 MUST 由 agent 自己的 systemPromptTemplate 提供,编排层 MUST NOT 持有角色阶段 prompt。

#### Scenario: 进 S7 唤醒 idle 的 qa

- **WHEN** engineer propose S6→S7 成功,qa seat 当前 `idle`
- **THEN** 系统 MUST promptSession 唤醒该 qa agent(不依赖 mention)
- **AND** 唤醒文本 MUST 通用("进入 S7,轮到你,自检产物就绪后开始"),MUST NOT 含"qa 该验收"等角色细节

#### Scenario: 进 S9 懒 spawn ci

- **WHEN** qa propose S7→S9 成功,ci seat 当前 `vacant`
- **THEN** 系统 MUST 懒 spawn ci agent
- **AND** S2 招募阶段 MUST NOT 提前 spawn ci(ci 推迟 spawn 成为通用懒 spawn 的一例)

### Requirement: 通用懒 spawn

所有角色 SHALL 在进入其活跃阶段时才 spawn(而非 S2 一次招满)。planner 仍在 S1 创建全部 seat 行(vacant),agent 进程 spawn 延迟到各角色活跃阶段。S2 招募态 SHALL 退化为瞬时 gate:进 S2 不 spawn 任何 agent,校验 seatPlan 已落(至少 engineer seat 存在)后立即 `advanceState(S2→S6)`。

#### Scenario: S2 瞬时 gate

- **WHEN** planner propose S1→S2,seatPlan 已含 engineer seat
- **THEN** 系统 MUST NOT 在 S2 spawn 任何 agent
- **AND** MUST 立即 advanceState S2→S6
- **AND** S6 入态 MUST 懒 spawn engineer 并唤醒

#### Scenario: S2 seatPlan 未就绪

- **WHEN** 进入 S2 但 seatPlan 尚无 engineer seat
- **THEN** 系统 MUST NOT advance,等 planner 补齐 seat(防止跳到无人可招的 S6)

### Requirement: 防静默 — idle-entry 生产力 hook

driver agent 在其活跃阶段 turn 结束(进 idle)时,系统 SHALL 检查本 turn 是否有"进展信号":propose 成功 OR 自身 deliverable 文件在本 turn 内被更新 OR 本 turn 发过 @他人/阻塞类 chatroom 消息。三者全无视为"空转"。空转时系统 MUST 软推(重新唤醒)该 seat,每 (seat, phase) 软推上限 2 次;超过上限 MUST 升级(置 task stalled + 通知人类)。phase-change 时软推计数 MUST 清零。

#### Scenario: 空转 turn 被软推

- **WHEN** engineer 在 S6 结束一轮 turn,既没 propose、没更新 eng/ deliverable、也没发阻塞消息
- **THEN** 系统 MUST 重新唤醒 engineer 提示"这轮没推进,请继续或报阻塞"
- **AND** 第 3 次空转 MUST 停止软推并升级人类

#### Scenario: 有进展的 turn 不软推

- **WHEN** qa 结束一轮 turn 且本轮发了 `@engineer 我在等你的 commit` 阻塞消息
- **THEN** 系统 MUST NOT 软推(发阻塞消息算进展)

### Requirement: 防静默 — timer watchdog + stalled

task-process 内 SHALL 运行阶段进度看门狗:追踪 `lastProgressAt`(phase-change / driver chatroom 消息 / tool-trace / markWorking 任一刷新)。当 task 非终态 且 距上次进展 > 10 分钟 且 driver 无活动(idle,或 working 但持续无 tool-trace)时,系统 MUST 升级。升级 MUST 置 `task.stalled=true`(含 reason + 时间戳)+ 发桌面通知 + 写 urgent chatroom 消息。任务后续出现任何进展信号 MUST 清除 stalled。

#### Scenario: 卡 working 永不 done 被 watchdog 兜

- **WHEN** ci 在 S9 进入 working 后 10 分钟无任何 tool-trace、无 chatroom 消息、状态未变
- **THEN** watchdog MUST 升级(stalled + 通知人类)

#### Scenario: stalled 后恢复

- **WHEN** 一个 stalled 的 task,其 driver 之后成功 propose 推进了状态
- **THEN** 系统 MUST 清除 task.stalled 标志
