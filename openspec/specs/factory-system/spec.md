# factory-system Specification

## Purpose
TBD - created by archiving change m1-skeleton. Update Purpose after archive.
## Requirements
### Requirement: 工厂 yaml 格式定义

工厂 SHALL 以 yaml 文件形式存放于 `~/.agent-team/factories/<name>.yaml`，字段必须 zod 校验通过才能加载。强制字段：`name`（planner / engineer / pm-ux / qa / anti / ci 之一）/ `version` / `persona` / `systemPromptTemplate` / `defaultNamePool[]` / `coreMcps[]` / `lifecycle`（当前固定 `alwaysOn`）。可选字段：`recommendedSkills[]` / `recommendedCliTools[]` / `recommendedMcps[]` / `preferredModelProfile` / `fallbackModelProfiles[]` / `defaultPermissions` / `workingHabits[]` / `deliverables[]`。

`preferredModelProfile` SHALL 描述该 factory 的 primary 本地 model profile 偏好，形态为 `{ provider, model?, cliBinary?, reasoningEffort? }`。`fallbackModelProfiles[]` SHALL 是同形态 model profile 的有序列表，仅在 primary model profile 不可用或因 provider availability 原因 spawn 失败时使用。

#### Scenario: 加载校验通过

- **WHEN** 系统启动加载 `~/.agent-team/factories/planner.yaml`
- **THEN** zod schema 校验通过，工厂注册到内存 registry，供 spawn 流程查询

#### Scenario: 加载校验失败

- **WHEN** 工厂 yaml 缺少必填字段（如 `defaultNamePool`）
- **THEN** 启动时 logger 报 ERROR 并停止该工厂注册；前端工厂管理页显示“配置错误”

#### Scenario: 工厂声明 primary 和 fallback model profile

- **WHEN** `planner.yaml` 声明 `preferredModelProfile.provider = claude-acp` 且 `fallbackModelProfiles[0].provider = codex-sdk`
- **THEN** 工厂 schema MUST 校验通过
- **AND** 前端工厂详情与 agent profile MUST 能展示 primary 与 fallback model profile 配置

### Requirement: 配置权三层

工厂的能力声明 SHALL 严格分三层:**core(架构必装,用户不可删,典型仅 `chatroom-mcp`)** / **recommended(工厂默认推荐,用户在工厂管理页可任意增删)** / **task-level mcpInjections(planner 在 task-plan 按上下文额外注入,如 `internal-cli`)**。spawn 时三层 merge:`coreMcps + recommendedMcps + mcpInjections`,name 冲突时 task 注入优先。

#### Scenario: 工厂管理页编辑

- **WHEN** 用户在前端工厂管理页删除某个 `recommendedSkills` 项
- **THEN** 工厂 yaml 版本 +1,后续 spawn 不再软链该 skill;但 `coreMcps` 字段在前端标灰锁定,鼠标 hover 显示"架构必装,不可删"

#### Scenario: mcpInjections 覆盖

- **WHEN** task-plan 的 `seatPlan` 给 engineer 注入 `{name: 'internal-cli', command: 'internal-cli', args: ['mcp']}`,而工厂 `recommendedMcps` 里没有 internal-cli
- **THEN** spawn 时该 agent 的 `mcp.json` 含 chatroom-mcp(core)+ 工厂 recommendedMcps + internal-cli(task 注入)

### Requirement: namePool 无重复抽签

agent spawn 时 MUST 从工厂 `defaultNamePool` 中**优先选未被本任务使用过的**历史人物名作为 `displayName`;若池已用尽则允许重复(M1 极小概率,不强约束);crash 重 spawn 重新抽签。

#### Scenario: 同工厂并发实例

- **WHEN** task 同时招 3 个 engineer(seatPlan 里 count=3),工厂 namePool 是 [墨子, 沈括, 张衡, 祖冲之, 毕昇]
- **THEN** 3 个 agent 分别叫"墨子"、"沈括"、"张衡",不重复

### Requirement: 工厂版本化与回滚

每个工厂 yaml MUST 维护 `version` 字段(整数),用户在工厂管理页保存修改时版本 +1,系统 SHALL 保留历史版本(`~/.agent-team/factories/<name>.v<n>.yaml.bak`),允许用户回滚到任意历史版本。

#### Scenario: 版本递增

- **WHEN** 用户编辑 planner 工厂的 `systemPromptTemplate` 并保存
- **THEN** 旧 `planner.yaml` 备份为 `planner.v3.yaml.bak`,新版 `planner.yaml` 的 `version: 4`

#### Scenario: 回滚

- **WHEN** 用户在工厂管理页选"回滚到 v3"
- **THEN** 系统把 `planner.v3.yaml.bak` 拷回 `planner.yaml`,version 字段写 `4`(后续不允许真正回到 3,只能再 +1 改名)

### Requirement: 工厂调优队列(复盘反哺)

planner 在 S11 复盘产出的"💡 优化建议"SHALL 自动入"工厂调优队列"(SQLite 表 `factory_tuning_queue`);用户在工厂管理页可逐条审阅,选择采纳(自动 patch 进工厂模板 + version +1)或 dismiss(标记原因)。

#### Scenario: 建议入队

- **WHEN** planner 在 retrospective.md 写"💡 建议给 engineer 工厂的 workingHabits 加一条:测试失败时优先看 lint 输出"
- **THEN** 系统从 retro 中解析建议,插入 `factory_tuning_queue` 表,关联到目标工厂 + 来源 task-id

#### Scenario: 用户采纳

- **WHEN** 用户在工厂管理页点某条建议的"采纳"
- **THEN** 显示与当前工厂模板的 diff 预览供确认,确认后修改 yaml + version +1 + 队列项标记 `accepted`

### Requirement: M1 只实现 planner + engineer

M1 阶段 SHALL 只交付 `planner.yaml` + `engineer.yaml` 两个工厂(对应 5 态状态机的需求);其余 4 个工厂(`pm-ux / qa / anti / ci`)由后续 milestone(M2/M3)交付。

#### Scenario: 调用未实现工厂

- **WHEN** task-plan 的 seatPlan 引用 `factory: 'qa'`
- **THEN** spawn 流程报错 `factory 'qa' not loaded in M1`,提示用户回到 planner 修改 plan

### Requirement: defaultNamePool 内置内容

M1 交付的两个工厂的 `defaultNamePool` MUST 固定为:

- planner: `["诸葛亮", "张良", "房玄龄", "王猛", "刘伯温"]`
- engineer: `["墨子", "沈括", "张衡", "祖冲之", "毕昇"]`

(后续 milestone 引入 pm-ux=`["鲁班", "顾恺之", ...]` 等)

#### Scenario: 默认池足够 5 个并发

- **WHEN** 同一任务的 engineer 实例并发数 ≤ 5
- **THEN** namePool 足够无重复分配

### Requirement: ci 默认工厂
factory-system SHALL 注册 `ci` 默认工厂。`apps/server/src/domain/factory/defaults/ci.yaml` MUST 存在并符合 `Factory` schema:`name=ci`、`lifecycle=alwaysOn`、`defaultNamePool` 非空、`coreMcps` 含 chatroom-mcp、`defaultPermissions.proposeTransitions` 含 `"S9->S10'"`、`deliverables` 含 `ci/ci_report.md`。

#### Scenario: 工厂加载时 ci 在注册表中
- **WHEN** server 启动并执行 `loadFactories(defaultsDir)`
- **THEN** registry MUST 包含 name=`ci` 的工厂实例
- **AND** 该工厂 lifecycle MUST = `alwaysOn`

#### Scenario: ci 工厂可被 planner 用 seat_create 招募
- **WHEN** planner 在 S2 调 `seat_create(taskId, role="CI #1", factory="ci")`
- **THEN** 该 seat MUST 成功创建,seat.factory = `ci`
- **AND** spawn 后 ci agent workspace 含 `ci.yaml` 快照 + `chatroom-mcp` + `pm` skill 软链 + `ci-monitor-handoff` skill 软链

### Requirement: ci 工厂复用 pm skill + 架构 override
ci 工厂 SHALL 在 `recommendedSkills` 含 `pm`(用户作用域 `~/.claude/skills/pm/` 的 pre-merge MR monitor),复用其 polling state machine / comment 分类 / reply&resolve 流程。但 ci 工厂 MUST 在 `systemPromptTemplate` 和 `ci-monitor-handoff` skill 中显式 **override** pm 默认的"self-fix"分支:任何 pm 标记为 `accepted`(需改代码)或"CI 失败需 smallest local fix"的 disposition,ci MUST **路由回 engineer**(写结构化 `ci/ci-issues-{n}.md` + `chatroom_send` `mention` engineer),MUST NOT self-fix。

#### Scenario: ci recommendedSkills 含 pm
- **WHEN** 读 `ci.yaml`
- **THEN** `recommendedSkills` MUST 含 `pm`
- **AND** MUST 含 `ci-monitor-handoff`(架构 override 薄壳)

#### Scenario: ci 遇 CI 失败 路由 engineer 不 self-fix
- **WHEN** ci 在 S9 通过 pm 工作流发现 CI 失败(或 comment 被分类为 `accepted` 需要改代码)
- **THEN** ci MUST 把失败/comment 抽成结构化 `ci/ci-issues-{n}.md` 制品(含失败 job / 报错栈 / 关联文件 / 推测原因 / 或 comment 评论者 / 文件 / 行号 / 原文 / 严重性)
- **AND** ci MUST `chatroom_send` `mention` engineer 把该制品路由过去
- **AND** ci MUST NOT 自己修改 worktree 源代码

#### Scenario: ci 用 pm 的 reply_only / needs_decision 分类直接回复
- **WHEN** ci 通过 pm 工作流发现 comment 被分类为 `reply_only` 或 `needs_decision`
- **THEN** ci MAY 自己直接 reply(`reply_only`)或主动 `mention` 人类/planner 升级(`needs_decision`),无需路由 engineer
- **AND** 上述 reply 行为 MUST NOT 修改 worktree 源代码

### Requirement: ci 工厂只搬运 / 不改源码(prompt 硬约束)
ci 工厂的 `systemPromptTemplate` 和 `workingHabits` MUST 显式禁止 ci agent 修改 team project 源代码(包括 worktree 内任何文件)。允许 ci 调用:`git push`、`gh pr create`、CI 触发、跑冒烟脚本、写 `ci/ci_report.md`。

#### Scenario: ci 工厂禁止改源码
- **WHEN** 读 `ci.yaml` 的 `systemPromptTemplate` 或 `workingHabits`
- **THEN** 内容 MUST 含明确禁止改 team project 源代码的字眼(如"不写业务代码"/"禁止改源码"/"只搬运")
- **AND** ci 入场提示(`task-process-entry.ts ciPrompt`)MUST 重申该约束

### Requirement: 默认工厂绑定本地 model profile preference

默认 planner / engineer / qa / ci 工厂 SHALL 声明面向本机 provider 的 model profile preference。planner primary MUST 为 `claude-acp` model `claude-opus-4.7` 且 `reasoningEffort = medium`，fallback MUST 包含 `codex-sdk` model `gpt-5.5` 且 `reasoningEffort = medium`。engineer / qa / ci primary MUST 为 `claude-acp` model `claude-sonnet-4.6`，fallback MUST 包含 `codex-sdk` model `gpt-5.4`。

模型名 SHALL 被 factory schema validation 当作 provider-native opaque string；provider adapter MAY 按 provider 能力校验或忽略不支持的模型名。

#### Scenario: planner 默认 model profile

- **WHEN** server 加载默认 planner factory
- **THEN** `preferredModelProfile` MUST 等于 provider `claude-acp`、model `claude-opus-4.7`、reasoning effort `medium`
- **AND** `fallbackModelProfiles` MUST 包含 provider `codex-sdk`、model `gpt-5.5`、reasoning effort `medium`

#### Scenario: execution factories 默认 model profile

- **WHEN** server 加载默认 engineer、qa、ci factories
- **THEN** 每个 factory MUST 有 primary provider `claude-acp` 且 model `claude-sonnet-4.6`
- **AND** 每个 factory MUST 有 `codex-sdk` fallback 且 model `gpt-5.4`

### Requirement: 仓库内 factory authoring skill

系统 SHALL 提供仓库内 skill，用于引导创建 factory。用户要求创建新 factory 时，skill MUST 至少收集：factory role/name、persona、primary provider/model/reasoning、fallback provider/model/reasoning、recommended skills/tools、deliverables、propose transitions、default name pool。该 skill SHALL 在实现流程中生成或更新 `apps/server/src/domain/factory/defaults/` 下的 factory YAML；本轮不要求前端写入或编辑 factory。

#### Scenario: 创建 factory 时收集必要信息

- **WHEN** 用户通过仓库 skill 要求创建 factory
- **THEN** skill MUST 在写入前询问缺失的 factory YAML 必填字段
- **AND** 生成的 YAML MUST 通过共享 `Factory` schema validation

#### Scenario: 前端不写 factory yaml

- **WHEN** 本 change 完成实现
- **THEN** 前端 MUST 对 factory YAML authoring 保持只读
- **AND** factory 创建 MUST 通过仓库 skill 或直接代码审查流程完成

### Requirement: ci factory 推迟 spawn

ci factory 的 seat 在 S2 招募阶段 MUST NOT 被 spawn(planner 仍可建 ci seat,seat 行写入 DB 但 status=vacant)。`transition-effects.ts` `applyTransitionEffects(to='S2')` MUST 过滤掉 factory='ci' 的 seat;`to='S9'` MUST emit recruit 事件,仅含 factory='ci' 的 seat。

目的:节省 S2-S9 期间 ci agent 待命的 token + 避免人类误以为 ci agent 在线可指挥。

#### Scenario: S2 招募跳过 ci

- **WHEN** task 进入 S2,planner 已建 engineer + qa + ci 三个 seat
- **THEN** `transition-effects.applyTransitionEffects` 触发的 `recruit` 事件 seatIds MUST 只含 engineer 和 qa 的 seat id
- **AND** ci seat 行存在但 status MUST 仍为 vacant
- **AND** SeatsBar / Avatar 显示 ci 为 vacant(灰)

#### Scenario: S9 入态触发 ci spawn

- **WHEN** qa S7 PASS 后 propose S9,task 含 ci seat
- **THEN** `transition-effects.applyTransitionEffects(to='S9')` MUST emit recruit 事件,seatIds 仅含 factory='ci' 的 seat id
- **AND** task-process 的 recruit handler MUST spawn ci agent
- **AND** ci agent 起来后 seat status MUST 从 vacant 经 init 到 idle

### Requirement: ci factory skill 可达性约束

ci factory 在 systemPromptTemplate 中 SHALL 引用以下 skill:`/local`(claude 内置)、`/pm`(全局 ~/.claude/skills)、`/deploy`(项目内)、`/ship-ticket`(项目内)。yaml `skillInjections` 字段 MUST 显式列出这些 skill 名称及来源(global / project / builtin)。

ci agent 在 S9 Step 0 MUST 实测 skill 可达性(至少调用 `/deploy --help` 一次)。不可达时 MUST chatroom_send 报告并停止后续 step。

#### Scenario: skill 不可达时 ci 停下

- **WHEN** ci Step 0 调用 `/deploy --help` 返回 "command not found" 或 stdout 为空
- **THEN** ci MUST `chatroom_send "skill 不可达,请人类介入"`
- **AND** ci MUST NOT 继续 Step 1-4(避免错误推送)
- **AND** task state MUST 保持 S9 等待人类介入

### Requirement: planner acceptance.md 加"影响范围"字段

planner 出 `plan/acceptance.md` 时,每个验收锚点 MUST 包含 `**影响范围**` 字段,值为 glob 列表(至少一项)。无法判定时 MUST 写 `**`(等于全量,放过增量验收)。planner system prompt MUST 包含此格式说明 + 示例。

格式约定:

```md
### 锚点 A1: <锚点名>
- **WHEN**: ...
- **THEN**: ...
- **影响范围**: `apps/foo/**`, `packages/bar/src/**`
```

#### Scenario: planner 出 acceptance.md 含影响范围

- **WHEN** planner 在 S1 阶段产出 plan/acceptance.md
- **THEN** 每个 `### 锚点 X<id>` 段落 MUST 包含 `**影响范围**` 字段
- **AND** 值 MUST 是 glob 字符串列表(逗号或换行分隔)

#### Scenario: 无法判定影响范围时用 \*\*

- **WHEN** planner 写某锚点但不确定影响哪些文件
- **THEN** 该锚点 `**影响范围**` 值 MUST 是 `**`(放过增量优化,等于全量)
- **AND** 不允许省略字段

### Requirement: ci factory version bump

本次 ci.yaml 从 v2 升 v3。engineer.yaml(v2→v3)、qa.yaml(v3→v4)、planner.yaml(v4→v5)同步升 version。改 systemPromptTemplate 即视为行为变化,版本号 MUST 递增。老 task 锁了旧版本不受影响(factory.lock.yaml snapshot 保留),新 task spawn 时 MUST 拿新版 prompt。

#### Scenario: 老 task 不受影响

- **WHEN** task 创建于 ci.yaml v2 时期,task.db 内 agents.factory_version=2
- **THEN** 新 server 启动 / 老 task 复活时 MUST 使用 v2 prompt
- **AND** factory.lock.yaml snapshot MUST 保留 v2 内容

#### Scenario: 新 task 拿新版本

- **WHEN** 新建 task 后 planner spawn
- **THEN** factories registry 中 ci/engineer/qa/planner 的 version MUST 为新版本号
- **AND** agent factory_version 列 MUST 写新值


### Requirement: Factory.systemDirective 系统层指令

Factory SHALL 支持可选字段 `systemDirective` —— 渲染进 system prompt 最前(最高优先级)、**对用户不可见**(工厂管理 UI MUST NOT 暴露 / 允许编辑)的系统层指令。未设置时 MUST 使用统一默认值 `DEFAULT_SYSTEM_DIRECTIVE`(推进本能契约:被唤醒即上场 / 完成即推进 / 阻塞即催不静默 / 收口优先 / 真卡住要喊)。各 factory MAY 覆盖做 per-role 强化。

最终 system prompt 渲染顺序 MUST 为:`systemDirective → persona → agent.md → systemPromptTemplate 角色职责`。

#### Scenario: 默认继承推进本能

- **WHEN** 某 factory yaml 未声明 systemDirective
- **THEN** spawn 该 factory 的 agent 时,system prompt 最前 MUST 注入 DEFAULT_SYSTEM_DIRECTIVE
- **AND** 内容 MUST 含"完成即推进 / 阻塞即催不静默"的核心动力学

#### Scenario: per-role 覆盖

- **WHEN** ci.yaml 声明了自己的 systemDirective(如额外强调"CI 绿就立刻 propose 别反复看")
- **THEN** spawn ci agent 时 MUST 用 ci 的 systemDirective 而非默认

#### Scenario: 用户不可见

- **WHEN** 用户在工厂管理界面查看 / 编辑 factory
- **THEN** systemDirective MUST NOT 出现在可编辑字段中(它是系统层,非用户配置)

### Requirement: 活跃阶段从 proposeTransitions 派生

系统 SHALL 把角色的"活跃阶段"定义为其 `defaultPermissions.proposeTransitions` 中所有转移的 `from` 状态(去重),不引入独立的 activePhases 字段。进态驱动唤醒(见 task-lifecycle)MUST 据此判定 driver。

#### Scenario: engineer 活跃于 S6

- **WHEN** engineer.proposeTransitions = ["S6->S7", "S6->S10'"]
- **THEN** 系统派生 engineer 活跃阶段 MUST 为 {S6}
- **AND** 进 S6 时 MUST 把 engineer 列为 driver

#### Scenario: planner 多活跃阶段

- **WHEN** planner.proposeTransitions 含 "S1->S2"、"S11->done"、"releasing->done"
- **THEN** 派生活跃阶段 MUST 含 S1、S11、releasing
- **AND** 进入这三个状态任一时 planner MUST 被唤醒
