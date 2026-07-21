# Agent Team 架构设计

> 版本: v0.5 (2026-06-23) — 必装/推荐二分清晰化 / 去 "必" 措辞 / Factory schema 重整 (coreMcps + recommendedMcps) / 删 allow-domains 特殊处理(agent 自决)
> 形态: 本地 Web App + 自建 chatroom-mcp + 本地 CLI 子进程作为 agent 运行时
> 详写节: §3 六个工厂规格 / §5 任务生命周期状态机 / §6 Agent Workspace 与 CLI 适配器 / §7 chatroom-mcp 设计 / §11 Chatroom 压缩方案

---

## 0. TL;DR

- **形态**: Node 后端 + React 前端的本地 Web App,**单用户**;后端编排,前端可视化。Tauri 套壳留作后续。
- **task 中心化**: 一切以 task 为中心。`~/.agent-team/` 下只两类:**全局 `factories/`** + **`projects/<project>/tasks/<task-id>/`**;agents 是 task 的成员,workspace 落在 task 内。
- **运行时**: 每个 agent = 一个本地 CLI 子进程(`claude` / `codex` / ...),task 内独立 workspace,工厂能力以软链方式注入;任务期间默认 idle 时 SIGSTOP 不占 CPU。
- **总线**: 自建 `chatroom-mcp` —— stdio MCP server,所有 agent 通过它收发消息、登记制品、查任务状态、上报访问的上下文。
- **核心抽象**: `Project → Task → Chatroom`;`Factory` 是角色模板,`Agent` 是 task 期间的一次性实例,chatroom 内以**岗位 (Seat)** 形式呈现。
- **6 个工厂**: `planner / pm-ux / engineer / qa / anti / ci`。所有工厂 **`lifecycle = alwaysOn`** —— S2 一次招满,工作之外保持 idle,**task done 才释放**;planner 兼任协调员 + 阶段公告 + 复盘。
- **Agent 默认名**: 从工厂的 `defaultNamePool` 取**中国历史人物**(planner=诸葛亮、engineer=墨子、qa=包拯 ...);前端 chip / 消息流以"历史人名 + 工厂"展示。
- **配置权三层** (v0.5):
  - **架构必装 (`coreMcps`)**: 系统强制,用户不可删,仅 `chatroom-mcp` 等;没它整套机制不工作
  - **工厂推荐 (`recommendedSkills` / `recommendedCliTools` / `recommendedMcps`)**: 工厂模板预填的"合理默认",**用户在工厂管理页可任意增删**
  - **任务级注入 (`SeatSpec.mcpInjections`)**: planner 在 task-plan 里按上下文额外加挂(如 `internal-cli` 用于内网任务);spawn 时 merge 进 mcp.json
  - **agent 自主**: agent 拿到工具集后,自己挑哪个用、用哪个子命令 —— `allow-domains` 这类精细 permission 不在架构层强制(早期可宽松,真要收紧由用户在工厂 permission 里写)
- **并行**: 每个 agent 独立子进程异步运行,通过 chatroom 协调而不互相阻塞。
- **隔离 + 共享**: task 目录是制品归档库;chatroom 是共享上下文中枢;hook 记录访问轨迹作为 dashboard 数据源。
- **编排**: orchestrator 是后端 TS 状态机引擎(**不是 agent**),收 `task_state_propose` 后规则化校验(文件存在 + schema + 内容 lint) → 推进 + 广播 `phase-change`。
- **复盘**: 任务完成 → **planner** 读全量 transcript + 制品 + 轨迹 → 产出 `retro/retrospective.md`;人类判定是否进入项目知识库。

---

## 1. 顶层架构与术语 [提纲]

- **系统形态**: 单机本地 Web App。后端 Node(TypeScript),前端 React。后端跑编排引擎、chatroom-mcp server、子进程池;前端通过 WebSocket 订阅 chatroom 事件流。
- **三层模型**:
  - **编排层 (orchestrator)**: 状态机推进、招募/释放 agent、阶段切换、门禁判定
  - **总线层 (chatroom-mcp + ws)**: agent ↔ agent / agent ↔ 人 / agent ↔ task 状态 全部走它
  - **运行时层 (CLI 适配器)**: claude / codex / 其他 CLI 的统一 spawn 接口
- **关键设计原则**:
  1. chatroom 是上下文唯一中枢 —— 没有 chatroom 不可见的私下通信
  2. Agent 是一次性的 —— 任务完成就释放,下次招新的;工厂定义可演化但实例不复用
  3. 任务目录是制品归档库 —— 任何"重要决策/产物"必须落盘
  4. 工厂可配置,不写死 —— 人设/skill/工作习惯都是数据
  5. 跨模型可插拔 —— CLI 适配器是边界,新模型接入只改适配器
  6. **用户决策权 > 工厂默认 > 架构最小集** (v0.5) —— 架构层只强制最小集(`coreMcps`、hooks);其他全是工厂"推荐",用户在前端可任意增删覆盖;agent 拿到工具集后**自主决策**用哪个子命令,permission 早期宽松,要收紧时由用户在工厂 permission 字段里显式写
- **依赖关系**: Web UI → orchestrator → (chatroom-mcp ↔ agent CLI 子进程) ↔ task 目录
- **部署形态**: 本地单机;数据放 SQLite + 文件系统,无云端。

---

## 2. 数据模型 [提纲]

```
Project
  ├─ id, name, repoPath
  ├─ factories[]              # 项目可用的工厂集(可从全局默认继承 + 覆盖)
  ├─ knowledge/               # 跨任务沉淀;入库由人类审核
  └─ tasks[]

Task                          # ★ 核心叙事单元,一切以 task 为中心
  ├─ id, project, title, type (bugfix | feature | refactor | ...)
  ├─ state (S0..S11), stateHistory[]
  ├─ workdir                   # = ~/.agent-team/projects/<project>/tasks/<id>/
  ├─ worktreePath              # ★ task-bootstrap-lifecycle: 不再由 planner 调 sw 创建;
  │                            #   由 orchestrator 的 bootstrap provider(generic-pnpm / sw)
  │                            #   程序化产出,记录在 task resource 而非 task 字段
  ├─ bootstrapConfig?          # ★ task-bootstrap-lifecycle: {provider, mode, enabled}
  │                            #   解析自 ~/.agent-team/projects/<projectId>/bootstrap.yaml
  ├─ resources[]               # ★ task-bootstrap-lifecycle: bootstrap 副作用的权威交接面
  │                            #   {id, kind:'worktree', status, provider, mode, path?, branch?,
  │                            #    baseRef?, summary?, error?, attempts}
  │                            #   status: creating | ready | failed | retained | removed
  │                            #          | archived | needs-review
  ├─ chatroomId
  ├─ planSummary               # planner 的拆分结论摘要
  ├─ seatPlan: SeatSpec[]      # planner 在 S1 产出的岗位清单
  └─ archived (bool), archivedAt

SeatSpec (in seatPlan, planner 在 S1 产出)
  ├─ seatId                    # 任务内唯一,如 "eng-1" / "qa-1"
  ├─ role                      # 角色展示名
  ├─ factory                   # 工厂引用名
  ├─ count?                    # 并发实例数,默认 1
  ├─ modelOverride?            # 可选: 覆盖该岗位 agent 的 provider/model,优先级高于工厂默认
  ├─ mcpInjections[]?          # ★ v0.4: 任务级动态 MCP 注入(在工厂默认 mcp.json 基础上 merge)
  │     例: [{name: "internal-cli",
  │            command: "internal-cli",
  │            args: ["mcp", "--allow-domains", "repo,wiki,ai"]}]
  │     仅在任务上下文需要(如内网链接、特定平台数据)时由 planner 显式声明
  └─ rationale?                # planner 给的"为什么需要这个岗位 + 这些注入"

Chatroom
  ├─ id, taskId                # 1:1 绑 task,不深度细分
  ├─ messages (append-only jsonl)
  ├─ subscribers[]             # 当前 agent + 人类前端连接
  ├─ phase                     # 状态机当前态(冗余,前端快速渲染)
  ├─ seats[]                   # 岗位 (Seat): {seatId, role, factory, status, agentId?, queue[]}
  │                            #   status: init | idle | working | offline | vacant
  │                            #   queue: 在该岗位离线时,被路由到此的 mention 排队
  ├─ subtasksDashboard[]       # {id, title, status, assignee, progress}
  └─ contextAccessLog[]        # context_log hook 上报的资源访问记录

Factory                       # 全局,~/.agent-team/factories/<name>.yaml
  ├─ name (planner | engineer | pm-ux | qa | anti | ci)
  ├─ persona                   # 人设描述,前端展示用
  ├─ systemPromptTemplate      # 含变量占位
  │
  │ # ★ v0.5: 配置权三层 —— core 强制 / recommended 工厂默认(用户可改) / mcpInjections task 级
  ├─ coreMcps[]                # 架构必装,用户**不能删**;典型值: ["chatroom-mcp"]
  ├─ recommendedSkills[]       # 工厂推荐 skill,用户在工厂管理页可任意增删
  ├─ recommendedCliTools[]     # 工厂推荐 bash CLI(如 docs-cli),用户可增删
  ├─ recommendedMcps[]         # 工厂推荐 MCP(如 Figma / Playwright),用户可增删
  │                            # ↑ v0.5: 合并旧的 requiredMcps(非 core 部分)+ optionalMcps
  ├─ preferredModelProfile?    # 工厂默认模型配置:{provider, model?, cliBinary?, reasoningEffort?}
  │                            # provider/model 选择发生在 agent/seat/factory 级,不是 task/team 级
  │
  ├─ defaultPermissions        # allow/deny list,渲染为 CLI --allowed-tools 等
  │                            # v0.5: 默认宽松(只挡明显危险的,如 rm -rf /);精细 permission 由用户写
  ├─ workingHabits[]           # 文字描述,会被注入 system prompt
  ├─ deliverables[]            # 产出契约: {type, pathPattern, schema?, contentLint?}
  ├─ defaultNamePool[]         # agent 展示名候选(中国历史人物)
  ├─ lifecycle                 # 当前固定 "alwaysOn":S2 一次招满 + task done 释放
  └─ version, updatedAt

Agent (task 内成员,一次性实例)
  ├─ id, factory, taskId, chatroomId, seatId
  ├─ displayName               # ★ v0.3:从 factory.defaultNamePool 抽签,如"诸葛亮"
  ├─ modelProfile               # spawn 时锁定的实际模型配置:{provider, model?, cliBinary?, reasoningEffort?}
  ├─ pid, model, cliBinary      # 从 modelProfile/provider 映射而来,用于观测与复盘
  ├─ workspacePath             # ★ = <task-workdir>/agents/<agent-id>/   (挪进 task 内)
  ├─ taskWorktreePath          # 引用 task.worktreePath,通过 --add-dir 注入到 CLI
  ├─ state (spawning | active | idle | offline | terminated)
  ├─ joinedAt, releasedAt
  ├─ skillsInstalled[]         # 软链 + 运行时新装的(用于复盘 diff)
  └─ handle                    # 后端持有的 stream 句柄

Artifact
  ├─ id, taskId, path
  ├─ type (proposal | acceptance | visual-contract | design | tasks
  │        | decisions | test-report | verification-report | verification-loop
  │        | anti-round-1 | anti-round-2 | ci-report | retrospective | other)
  ├─ producer (agentId)
  ├─ summary                   # agent 登记时附的一行摘要
  └─ refs[]                    # 引用了哪些其他 artifact
```

**全局目录骨架**:

```
~/.agent-team/
  factories/                            # ← 全局工厂定义,与 projects/ 平级
    planner.yaml
    pm-ux.yaml
    engineer.yaml
    qa.yaml
    anti.yaml
    ci.yaml
  projects/
    <project>/
      knowledge/                        # 跨任务沉淀(人类勾选才入库)
      tasks/
        <task-id>/                      # ★ task 是核心,以下一切是 task 的子项
          chatroom.jsonl
          state.json
          worktree/                     # ★ 由 bootstrap provider (generic-pnpm / sw adapter) 创建;
                                        #   未启用 bootstrap 或 bootstrap failed 时该目录可能不存在
                                        #   或为空,task resource 的 status 才是权威依据
          agents/                       # ★ v0.3:agents 是 task 的成员
            <agent-id>/                 #   = "<factory>-<task-short>-<n>"
              .claude/
                settings.json           #   注入 hooks + permissions
                skills/                 #   软链全局 ~/.claude/skills/<skill>
                                        #   运行时新装 skill 落这,不污染全局
              mcp.json                  #   chatroom-mcp + 工厂指定 MCP
              notes.md                  #   agent 自己的 scratch
              factory.lock.yaml         #   招募时的工厂版本快照
          plan/{task-plan.md, phase-notices.md}
          pm-ux/{proposal.md, acceptance.md, visual-contract.md}
          eng/{design.md, tasks.md, decisions.md, test-report.md}
          qa/{verification_report.md, verification_loop_1.md, ...}
          anti/{round1.md, round2.md}
          ci/{mr-link.txt, ci_report.md, ci-issues-1.md, ...}
          retro/retrospective.md
```

**为什么 agents 在 task 内**: task 是叙事核心,agent 是 task 期间的一次性资源;`task done = rm -rf task/<id>` 时 agents 也跟着归零,无悬挂状态。

---

## 3. 六个工厂规格 [详写]

每个工厂同一种 schema,核心 8 块: **lifecycle / 默认名 / 人设 / system prompt 要点 / 推荐 skill+MCP+CLI tools / permissions / 工作习惯 / 必交付物**。

> v0.2 → v0.3 主要变化: **所有工厂 `lifecycle = alwaysOn`**(S2 一次招满 + task done 才释放,非工作阶段 idle + SIGSTOP);新增 `recommendedCliTools[]` 字段(bash 命令白名单);新增 `defaultNamePool[]`(中国历史人物,招募时抽签);pm-ux 的 `internal-cli` 从 skill 改为 cliTool;增 `docs-cli`(planner + pm-ux)。

> v0.3 → v0.4 主要变化: **`internal-cli` 从工厂默认配置中解耦** —— 不进任何工厂的 `recommendedCliTools` / `requiredMcps`;改由 planner 在 `task-plan.md` 的 `seatPlan[].mcpInjections` 按任务上下文显式声明,orchestrator spawn 时 merge 进 agent 的 mcp.json;**`docs-cli` 保留默认**(pm-ux + planner,跨场景通用);新增**按需 MCP 注入机制**(见 §6.8)。

> v0.4 → v0.5 主要变化: **必装 / 推荐二分清晰化** —— 工厂里所有 skill / cli / mcp **去掉 "(必)" 措辞**,统一为"推荐",用户在工厂管理页可任意增删;架构层只保留 `coreMcps`(`chatroom-mcp` 等)是真的必装、用户不可删;`internal-cli mcp` 调用**不再特殊处理 `--allow-domains`**(agent 自主决策),早期 permission 控制宽松;planner 在 task-plan 里也只是**建议**注入哪些 MCP,具体子领域由 agent 自决。

### 3.1 Planner 工厂(全程在线 · PM 接口)

- **lifecycle**: `alwaysOn`(S2 招募就位 → 全程在线 → S11 复盘完成才释放)
- **默认名 (defaultNamePool)**: **诸葛亮** / 张良 / 房玄龄 / 王猛 / 刘伯温
- **人设**: 技术管理者气质。沉稳、问题导向、不写代码、关注分解与依赖、对模糊点零容忍。任务全程作为**用户 ↔ 团队的 PM 接口** + **内部协调员** + **复盘官**。
- **三重职责**:
  - **S1 规划**: 与用户多轮对齐 → 出 `plan/task-plan.md` + 岗位清单 → 触发招募
  - **S2~S10 协调**: 默认沉默,被 @ 时响应用户/同伴的问题、协调内部分工(eng ↔ pm-ux 信息不齐 / qa 失败追因 / anti blocker 归属裁决);每次 `phase-change` 主动发一条简报(取代旧通讯员)
  - **S11 复盘**: 任务 done 后读 transcript + 制品 + 状态机轨迹 → 出 `retro/retrospective.md`
- **system prompt 要点**:
  - 你是任务规划者 + 协调员 + 复盘官,任务期间长期在线
  - 你不编码、不实现;你的产出是 `plan/task-plan.md`、`plan/phase-notices.md`(累积)、`retro/retrospective.md`
  - **S1 第一回合做"context echo"**: 复述需求 + 已知信息 + 不明确的点,等用户确认;**禁止脑补**
  - 然后给 2-3 个分工方案(角色组合 + 子任务切分 + 依赖 + 验收锚点),推荐一个并说明理由;用户拍板后落 `task-plan.md` + 岗位清单
  - 中后期**默认沉默**: 只在被 @ 或收到 `phase-change` 事件时发声,避免噪声
  - `phase-change` 时主动发一条简短公告("现在到了 SX,负责 Y 接手,预期产出 Z")
  - 收到 anti R2 blocker / qa verification_loop 时主动 ping 用户(总结 + 影响 + 你建议怎么处理)
  - S11 复盘必须**分级**: ✅ 做得好 / ⚠️ 做得不好 / 💡 建议;不写场面话
- **推荐 skill**: `writing-plans` / `brainstorming` / `deep-research`(若需先研究)/ `consolidate-memory`(复盘归纳);**`sw` 已移除**(task-bootstrap-lifecycle:worktree 由 orchestrator bootstrap provider 程序化创建,planner 只读 resource,不负责执行)
- **推荐 CLI tools**: `docs-cli`(协调期间临时查内部协作平台表 / 拉文档)
- **架构必装 MCP**: `chatroom-mcp`
- **推荐 MCP**: WebFetch / internal-api / issue-tracker / figma 取数适配等(用户可改)
- **permissions**: 只读(源码、外部链接);允许 `chatroom_send` / `artifact_register`;`task_state_propose` 限规划/复盘相关转移(`S0→S1 / S1→S2 / S10→S11 / S11→done`);允许 bash 调用 `docs-cli`;**禁止**改源码、git、push
- **工作习惯**:
  1. S1 入场第一条消息固定模板: "📋 任务理解 + 已知信息 + 需澄清问题"
  2. 拆分方案以表格呈现: 角色 × 子任务 × 依赖 × 预估
  3. 显式标注 **anti R1 开关**(默认: `type=feature` 开 / `type=bugfix` 关,可手动覆盖)
  4. 中期 ping 用户的消息必须自带"建议动作"(继续 / 改方向 / 暂停 / 升级人类)
  5. 复盘要分**工厂维度**(每个工厂做得好/不好)+ **协作维度**(谁等谁、信息错配、卡顿点)
  6. **按需 MCP 注入**(v0.4+): 若任务上下文涉及内网资源(issue-tracker 链接 / 内部代码仓 / 内部 wiki / 内部 API),在 `seatPlan` 中为相关岗位**建议** `mcpInjections`(典型如 `internal-cli`);v0.5 起**不必标注 `--allow-domains`**,agent 拿到 MCP 后自主决策用哪个子领域;**不涉及内网就别注入**,避免工具污染
- **必交付物**:
  - `plan/task-plan.md`(任务摘要 / 角色组合 / 岗位清单 / 子任务依赖图 / 验收锚点 / anti R1 开关)
  - `plan/phase-notices.md`(累积:每次 phase-change 的简报)
  - `retro/retrospective.md`(S11 产出)

### 3.2 PM&UX 工厂

- **lifecycle**: `alwaysOn`(S2 就位 → S3 集中工作 → 之后 idle 待 mention → task done 释放)
- **默认名 (defaultNamePool)**: **鲁班** / 顾恺之 / 黄公望 / 吴道子
- **人设**: 产品 + 设计混合气质。关注用户故事、验收可执行性、视觉合约严格度。对"差不多就行"过敏。
- **system prompt 要点**:
  - 你负责把需求转化为 **结构化的 proposal + 可机验的验收标准 + 视觉合约**
  - 不写代码,但你的产出是 engineer 和 qa 的唯一依据
  - proposal 结构(类似 openspec): 背景 / 目标 / 非目标 / 用户故事 / 边界 case
  - acceptance 结构: 编号化的条目,每条必须包含 **触发条件 / 预期结果 / 验证方式**;qa 能直接照做
  - 视觉合约用 `ui-impl` skill 处理: 组件清单 + 状态矩阵(default/hover/active/disabled/loading/error/empty)+ 关键尺寸/颜色 token
  - **内部协作平台资源**: 用 `docs-cli`(默认已配)+ 配合 `docs-fetch / table-fetch / wiki-fetch / sheet-fetch` skill;**不要让 WebFetch 撞墙**
  - **公司内网资源**(issue-tracker / internal-api / 内部 wiki / 内部代码仓): 仅当 task-plan 给你注入了 `internal-cli` MCP 时才用;若没注入但你判断需要,先在 chatroom @ planner 请求添加注入,**不要自己拼 bash internal-cli**
- **推荐 skill**: `ui-impl` / `docs-fetch` / `table-fetch` / `wiki-fetch` / `sheet-fetch`(配合 docs-cli)
- **推荐 CLI tools**: `docs-cli`(内部协作平台资源命令式取数 + OAuth 鉴权)
- **按需注入 MCP**(由 task-plan 触发): `internal-cli` 内部资源访问(allow-domains 不强制,agent 自决)
- **架构必装 MCP**: `chatroom-mcp`
- **推荐 MCP**: Figma 取数适配 / issue-tracker 取数等(用户可改)
- **permissions**: 只读源码;允许写 `pm-ux/*.md`;允许 bash 调用 `docs-cli`;internal-cli 走 MCP(若注入);**禁止**改源码、git
- **工作习惯**:
  1. 入场先扫所有上下文链接;**不确定的点 @ planner 或人类**,不要凭空脑补
  2. 视觉合约必须列全组件状态矩阵,缺一个状态都不算完成
  3. 每条验收标准都要有**可机验的判定方式**(像素差 / DOM 断言 / 文案匹配 / 时序条件)
  4. 完成后调 `chatroom_send(type=handoff)` 显式交接给 engineer
- **必交付物**:
  - `pm-ux/proposal.md`、`pm-ux/acceptance.md`、`pm-ux/visual-contract.md`

### 3.3 Engineer 工厂

- **lifecycle**: `alwaysOn`(S2 就位 → S4 设计 → S6 实现 → S9 应 CI 路由问题 → 各阶段间 idle → task done 释放)
- **默认名 (defaultNamePool)**: **墨子** / 沈括 / 张衡 / 祖冲之 / 毕昇
- **人设**: 高级工程师气质。关注架构合理性、可测性、变更影响、设计文档先行。讨厌"先写再说"。
- **system prompt 要点**:
  - 你负责 **技术设计 → 实现 → UT/E2E → 响应 CI/comment 问题**,严格分阶段
  - S4 设计阶段产出 `eng/design.md`(类似 openspec design: 整体设计 / 数据流 / 接口契约 / 错误处理 / 改动文件清单)+ `eng/tasks.md`(子任务清单 + 顺序 + 每个子任务的验收点)
  - S6 实现阶段严格按 tasks.md 走,**每完成一个子任务 commit 一次**;遇到与 design 偏离的决策记到 `eng/decisions.md`
  - 必须本地跑通 ut + e2e 才能宣告进入 S7;`eng/test-report.md` 给出测试覆盖与运行结果
  - **S9 期间 ci 工厂会把结构化的 CI 失败/comment 上下文路由给你**,你按 issue 修 → commit → 通知 ci 重跑
- **推荐 skill**: `test-driven-development` / `systematic-debugging` / `ui-impl` / `harness-engineering` / `subagent-driven-development`(复杂任务可派子 agent)/ `verification-before-completion` / `receiving-code-review`(应 ci 路由回来的 comment 用)
- **架构必装 MCP**: `chatroom-mcp`
- **推荐 MCP**: 项目内 MCP(数据库 / API / 内部工具等;用户按项目改)
- **permissions**: 全读写源码、跑测试、git commit(在 worktree 内);**禁止** `git push` / `gh pr` / 合 MR(那是 CI 工厂的活)
- **工作习惯**:
  1. S4 设计阶段先在 chatroom 发"会改的文件清单",让 anti(若 R1 开启)预审,避免"设计完成才发现要重写"
  2. S6 每完成一个子任务,在 chatroom 发一条 < 80 字的简报: "✅ subtask-X 完成,改动: ..., commit: ..."
  3. 非显然决策(选 A 不选 B 的理由)必须记 `decisions.md`,不要藏在 commit message 里
  4. 测试失败时不要"硬过": 要么修代码、要么修测试、要么修标准;但要在 chatroom 说清楚走了哪条路
  5. 应 CI 路由回来的 issue 时,优先 fix;不能直接 fix 的回 chatroom 解释(可能需要改 acceptance,@ pm-ux + planner)
- **必交付物**:
  - `eng/design.md` / `eng/tasks.md` / `eng/decisions.md` / `eng/test-report.md` + 代码 commits

### 3.4 QA 工厂

- **lifecycle**: `alwaysOn`(S2 就位 → S7 工作 → 失败/重试在同一实例内,判定口径一致 → idle → task done 释放)
- **默认名 (defaultNamePool)**: **包拯** / 宋慈 / 狄仁杰 / 海瑞(宋慈是《洗冤集录》验尸鼻祖,与 QA 严判证据匹配)
- **人设**: 严谨、对照标准、不放过细节。默认"东西就是有问题的",直到逐条验证过去。
- **system prompt 要点**:
  - 你按 `pm-ux/acceptance.md` + `pm-ux/visual-contract.md` **逐条**验证,不增不减
  - 验证开始前先 echo 一次自己理解的标准给 chatroom,让 pm-ux 确认无歧义(若 pm-ux 已不在线,@ planner 帮忙仲裁)
  - 每条标准给出 ✅ / ❌ / ⚠️(部分通过)+ 证据(截图路径 / 命令输出 / DOM 状态)
  - **任何一条未过就产出 `qa/verification_loop_{n}.md`**: 问题描述 / 重现路径 / 代码点位(file:line)/ 修复方案建议
  - 100% 通过才能放行;有任何 ❌ 都退回 S6
- **推荐 skill**: `verify` / `run`
- **架构必装 MCP**: `chatroom-mcp`
- **推荐 MCP**: `Playwright MCP`(浏览器自动化 / e2e 验证主用)/ Claude Preview MCP(辅助)/ computer-use(桌面端验证,可选)
- **permissions**: 只读源码、启动 dev server、跑测试、截图、Playwright 控制浏览器;**禁止**改源码
- **工作习惯**:
  1. 验证报告以表格呈现: `编号 × 标准 × 结果 × 证据 × 备注`
  2. 失败必须给**可执行的修复建议**(具体到文件 + 大致改法),不写"看起来不对"这种空话
  3. 视觉验证用 `ui-impl` 产物 + Playwright 截图对照,像素差超过 token 容差视为 ❌
  4. 进入循环 n>1 时,先确认 engineer 已经声明修复完成(避免抢跑)
- **必交付物**:
  - `qa/verification_report.md`(终态)、若有失败的 `qa/verification_loop_{n}.md`

### 3.5 Anti 工厂(两轮同一实例)

- **lifecycle**: `alwaysOn`(S2 就位 → S5 R1 工作(若启用)→ S8 R2 工作 → 中间 idle → task done 释放;**两轮天然同一实例,R2 时可直接读到 R1 备忘**)
- **默认名 (defaultNamePool)**: **魏徵** / 比干 / 寇准 / 司马光
- **人设**: 挑剔的资深 reviewer。对抗性思维,**默认被审的有问题**,目标是找问题不是确认正确。
- **system prompt 要点**:
  - 你是对抗审查员,**两轮职责**(同一实例跨两轮,R2 时保留 R1 上下文):
    - **R1**(可选,planner 决定): 审 proposal + design,看需求理解是否准确、技术方案是否合理、是否漏了关键 case
    - **R2**(必须): 审代码改动,看 bug / 安全 / 性能 / 可维护性 / 与 design 一致性;**重点验证 R1 提的问题是否真的落实了**
  - 输出 `anti/round{1,2}.md`,**分级**: `🔴 blocker` / `🟠 must-fix` / `🟡 nice-to-have` / `⚪ nit`
  - 只挑刺,**不写"这块写得不错"**;赞美不是你的工作
  - blocker 必须修;must-fix 强烈建议修;nice-to-have 可不修但要记录在 `decisions.md`
  - **死循环上限**: 同一轮 R2 ↔ engineer 反复回打 **3 次** 仍有 🔴,你必须主动 @ planner 升级人类介入
- **推荐 skill**: `code-review` / `security-review` / `receiving-code-review`
- **架构必装 MCP**: `chatroom-mcp`
- **推荐 MCP**: (按项目需要)
- **permissions**: 只读
- **工作习惯**:
  1. 每条意见引用具体行号(file:line)
  2. 给出意见时附**一个最小化的可疑场景**或反例,而不是抽象描述
  3. R2 时先抓 design.md 与实际改动的偏离点 —— 偏离 ≠ 错,但需要解释
  4. R1+R2 都用固定总结结构: "🔴 N 项 / 🟠 N 项 / 🟡 N 项 / ⚪ N 项,推荐动作: ..."
  5. R2 时**先翻 R1 备忘录**(同实例可见),逐条检查 R1 的发现是否在代码里 actually 修了
- **必交付物**:
  - `anti/round1.md`(若 R1 开启) / `anti/round2.md`(必须)

### 3.6 CI 工厂(只搬运 / 不改代码)

- **lifecycle**: `alwaysOn`(S2 就位 → S9 工作至 ready2merge → idle → task done 释放)
- **默认名 (defaultNamePool)**: **萧何** / 管仲 / 张居正 / 王安石
- **人设**: DevOps + 守门员气质。流程熟练、对 MR/CI/部署/comment 处理有耐心。**不写业务代码**。
- **system prompt 要点**:
  - 你负责 **MR 创建 → staging/Online 小流量部署 → CI 轮询 → comment 聚合与路由 → ready2merge 上报**
  - 用 `pm` skill(pre-merge monitor) 做轮询自动化
  - **不 self-fix 任何代码问题**;无论 lint / typo / 逻辑,统统**结构化路由回 engineer**:
    - 抽取 CI 失败的关键信息(失败 job / 报错栈 / 关联文件 / 推测原因)
    - 抽取 comment 的关键信息(评论者 / 文件 / 行号 / 原文 / 严重性)
    - 整理为 `ci/ci-issues-{n}.md`(结构化清单)
    - 调 `chatroom_send(type=handoff, to=engineer, refs=[issue 清单])` 显式路由
  - 部署小流量后必须**主动跑一次冒烟验证**(Playwright / curl 简单访问关键路径)再进入 ready2merge 等待
  - ready2merge 时调 `task_state_propose(S9→S10)`,触发 orchestrator 的桌面通知 hook
- **推荐 skill**: `pm`(pre-merge monitor) / `requesting-code-review` / `rebase` / `finishing-a-development-branch`
- **架构必装 MCP**: `chatroom-mcp`
- **推荐 MCP**: 内部代码仓 MR 工具 / CI 工具 / Playwright MCP(冒烟验证用)
- **permissions**: `git push` / MR create / CI 触发 / 跑冒烟脚本;**禁止**改源码(包括 worktree 内任何文件)
- **工作习惯**:
  1. MR 描述固定模板: 背景 / 改动概要 / 验收点 / 风险与影响范围 / MR 类型(feat/fix/...)
  2. 小流量部署后**必须**跑一次冒烟验证,不能盲信"看起来没崩"
  3. CI 失败 / comment 处理流程: 抽取 → 结构化 → 路由 engineer → 等 engineer 修复 commit → 重跑 CI / 回复 comment
  4. 每轮 CI 失败都登记一份 `ci/ci-issues-{n}.md`,便于复盘
- **必交付物**:
  - `ci/mr-link.txt`、`ci/ci_report.md`、`ci/ci-issues-{n}.md`(每轮 CI 失败)、ready2merge 事件

> **v0.1 的通讯员工厂已删除**。其"阶段切换简报"职责合并到 planner(全程在线,自动响应 `phase-change`);其"ready2merge 通知"职责合并到 orchestrator 内置 hook(`task_state == ready2merge` 触发浏览器 Notification API 桌面通知)。前期不发内部协作平台 / email,人类通过桌面通知 + chatroom 同步即可。

---

## 4. Chatroom 协议 [提纲]

- **消息类型**: `human-msg` / `agent-text` / `agent-tool-call` / `agent-tool-result` / `system-event` / `phase-change` / `artifact-event` / `subtask-update` / `handoff` / `mention`
- **频道**(同一 chatroom 内可分轨,降低噪声):
  - `main` —— 所有人/所有 agent 默认订阅,人类发言、决策、阶段公告都走这里
  - `eng-internal` —— engineer 自言自语 / 子任务进展简报
  - `tool-traces` —— 工具调用流(默认折叠,展开看)
  - `mentions` —— @ 路由
- **订阅模型**: agent spawn 时按工厂配置订阅频道集;前端订阅全部
- **持久化**: `chatroom.jsonl` append-only;每条消息有 `id / ts / channel / sender / type / content / refs[]`
- **与 task 目录关系**: 消息**引用** artifact 路径而不复制内容,前端按需懒加载
- **上下文喂入策略**: 新 agent 入场时根据工厂配置喂入 `main` 频道最近 N 条 + 相关 artifact 摘要,而非全量(避免 token 爆炸)

---

## 5. 任务生命周期状态机 [详写]

### 5.1 状态总览

```
[S0 任务首页填表]
       ↓ 人类点 "开始"
[S1 规划]              ← planner 进场,与人类多轮对齐
       ↓ task-plan.md + 岗位清单
[S2 招募]              ← orchestrator 按岗位清单 spawn 全部 agent
       ↓ 全员就位
[S3 PM&UX]             ← pm-ux 输出 proposal / acceptance / visual-contract
       ↓
[S4 Eng 设计]          ← engineer 输出 design / tasks
       ↓
[S5 Anti R1]?          ← planner 在 task-plan 里标记开关
       ↓ no blocker
[S6 开发]              ← engineer 实现 + 本地 ut/e2e
       ↓
[S7 QA] ←──────────────┐
       ↓ ❌            │
       └──────────────→ S6 (写 verification_loop_n.md)
       ↓ 100% pass
[S8 Anti R2] ←─────────┐
       ↓ ❌            │
       └──────────────→ S6 (第 3 次仍 🔴 → planner 升级人类)
       ↓ no blocker
[S9 CI]                ← ci 创建 MR + 部署 + 轮询;问题路由回 engineer
       ↓ ready2merge
[orchestrator hook]    ← 触发桌面 Notification(取代旧通讯员)
[S10 等待人类]         ← 人类审 MR、合入 / 暂缓
       ↓ 人类点 "完成"
[releasing]            ← ★ task-bootstrap-lifecycle:收尾编排,agents 仍在线
                         planner 出 retrospective.md + archive-plan.md;
                         resource release provider 把 worktree 等终态化
                         (retained / removed / archived / needs-review)
       ↓ 终态明确
[S11 归档+复盘 / done] ← orchestrator 释放全员、归档 snapshot,task = done
```

> 注:`releasing` 是 v0.6 (task-bootstrap-lifecycle) 引入的**内部 TaskState**(不是单纯 UI 标签);前端展示为"收尾中"。早期不存在 bootstrap 资源的历史任务在 done 时不经过 releasing,resource 列表显示为 `unknown` / `legacy`,不做复杂回填(见 §10 迁移策略)。

### 5.2 状态表

| 状态 | 入态条件 | 负责 | 产出 | 退出条件 | 失败回退 |
|---|---|---|---|---|---|
| **S0 任务首页填表** | 用户在首页新建 task | 人类 | 标题 + 类型 + 描述 + 上下文链接 | 人类点 "开始" | — |
| **S1 规划** | S0 点 "开始" | planner | `plan/task-plan.md` + `seatPlan` | planner `task_state_propose(S2)` + 人类确认 | 人类驳回 → planner 重做 |
| **S2 招募** | S1 完成 | orchestrator (脚本) | **一次招满** seatPlan 全部岗位(planner 已在 S1 就位,这里补齐其余)+ 喂入上下文 | 全员 `state==idle` | spawn 失败 → 重试 / 告警人类 |
| **S3 PM&UX** | S2 完成 | pm-ux | `pm-ux/{proposal,acceptance,visual-contract}.md` | pm-ux propose(S4) | — |
| **S4 Eng 设计** | S3 完成 | engineer | `eng/{design,tasks}.md` | engineer propose(`S5` 若 R1 开 / `S6` 否则) | — |
| **S5 Anti R1**(可选) | S4 完成 & `task-plan.antiR1==true` | anti | `anti/round1.md` | 无 🔴 blocker | 有 🔴 → 按归属回 S3 / S4 |
| **S6 开发** | S4 或 S5 完成 | engineer | 代码 commits + `eng/{decisions,test-report}.md` | 本地 ut/e2e 全过 + engineer propose(S7) | 自己迭代 |
| **S7 QA** | S6 完成 | qa | `qa/verification_report.md` | 100% pass | ❌ → 回 S6 + 写 `qa/verification_loop_{n}.md` |
| **S8 Anti R2**(必须) | S7 100% pass | anti (**同一实例**) | `anti/round2.md` | 无 🔴 blocker | 有 🔴 → 回 S6;**回打 ≥ 3 次仍 🔴 → @ planner 升级人类** |
| **S9 CI** | S8 完成 | ci | `ci/{mr-link.txt, ci_report.md, ci-issues-{n}.md}` | ready2merge | CI 失败 / comment → 结构化路由回 engineer(回 S6 修复 commit → 重入 S9) |
| **S10 等待人类** | S9 ready2merge | orchestrator hook | **桌面 Notification** + chatroom `phase-change` | 人类点 "完成" / "暂缓" | "暂缓" → idle 等指令 |
| **S11 归档+复盘** | 人类点 "完成" | planner | `retro/retrospective.md` + 知识库候选项 | planner propose(done) → **此处统一释放全部 agent**(task 内唯一的正常释放点) | — |

### 5.3 门禁规则

- **S0 → S1**: 上下文链接至少 1 条非空(防空任务)
- **S5 Anti R1**: 由 **planner** 在 `task-plan.md` 显式开关;默认 `feature=true / bugfix=false`
- **S7 QA**: **强制 100% pass**;有任何 ❌ 都不能放行
- **S8 Anti R2**: **必须**,且**只看代码**;无 🔴 才能进 S9
- **S8 死循环上限**: 同一轮 `S8 → S6 → S7 → S8` 回打 **3 次**仍 🔴 → anti 必须 @ planner 升级,planner 通知人类决策(改 acceptance / 重新设计 / abandon)
- **S9 ready2merge**: CI 全绿 + comment 全处理(fix / 解释保留 / 标记 nit)
- **S10 → S11**: 必须人类显式确认("完成"按钮),不允许 agent 自动归档

### 5.4 状态转换的 propose 权限

不是所有 agent 都能 propose 任意转移。每个工厂的 permission 里指定其可 propose 的转移集:

| 工厂 | 可 propose 的转移 |
|---|---|
| planner | `S0→S1`, `S1→S2`, `S10→S11`, `S11→done` |
| pm-ux | `S3→S4` |
| engineer | `S4→S5`(若 R1 开)/ `S4→S6`(若 R1 关)/ `S6→S7` |
| qa | `S7→S8`(100% pass)/ `S7→S6`(失败) |
| anti | `S5→{S3,S4,S6}` / `S8→{S6,S9}` |
| ci | `S9→S10` |
| orchestrator | `S2`(spawn 完成)/ `S10`(ready2merge hook)/ 兜底 |

### 5.5 任务首页发起流程(S0 → S1 的具体动作)

1. 人类在 web 首页填: **标题 + 类型(bugfix/feature/refactor/...) + 描述 + 上下文链接列表**(issue-tracker / figma / docs / 内部协作平台)
2. 点 "开始" → orchestrator:
   - 生成 `task-id`(短 uuid,如 `ex-23ab`)
   - 创建 `~/.agent-team/projects/<project>/tasks/<task-id>/` 目录骨架
   - **并行**启动:(a) planner 初始化 + chatroom 预创建 `planner` 岗位;(b) `TaskBootstrapRunner.prepare()` 按项目默认 `bootstrap.yaml` 调 `generic-pnpm` / `sw` provider 创建 worktree resource(`creating → ready/failed`)
   - bootstrap 不阻塞 planner 进入 S1;engineer/qa/ci spawn 前由 §6.2a gate worktree ready
3. orchestrator 招 planner: 从 factory 模板 → spawn agent → 岗位 `vacant → init → idle`
4. orchestrator 把人类填的所有内容作为初始 `human-msg` 喂入 chatroom
5. 状态进入 S1,planner 触发 "context echo",开始对话

### 5.6 暂停 / 恢复 / Crash / 杀死

- **暂停**: 任何状态可暂停 → 所有 agent 收到 `system-event: pause` → 完成当前消息进入 `state==idle`(进程不杀,保留 transcript)
- **恢复**: 所有 idle agent 收到 `system-event: resume` → 继续
- **Crash**(agent 进程异常退出): 该 agent 标记 `terminated`,岗位状态 `working/idle → vacant`;orchestrator 自动从工厂模板重 spawn 一个新实例(displayName 重新抽签,新实例通过 `chatroom_recent` + `artifact_list` 重建上下文,**不沿用 crash 实例的 transcript**)
- **杀死任务**: 释放所有 agent + 任务目录保留 + 标记 `aborted` + 跳过复盘

### 5.7 跨 agent 异步语义

状态机线性,但**单个状态内多 agent 可并发**:
- S3 pm-ux 可派子 agent 处理多 Figma 链接
- S6 engineer 可用 `subagent-driven-development` 派子任务并行实现
- S7 qa 可同时跑交互验证 + 视觉验证(Playwright)
- planner 在任何状态都可被 @ 介入,不阻塞主流

并发的 agent 共享 chatroom,通过 `subtask_update` 同步进度,在 dashboard tab 实时可见。同状态多 agent 之间不阻塞;**只有 propose 状态转移时 orchestrator 才介入**。

### 5.8 Agent lifecycle 总览(v0.3 关键调整)

所有工厂统一 `lifecycle = alwaysOn`:

| 时间段 | Agent 行为 | 进程状态 |
|---|---|---|
| **S1**(任务起点) | planner 单独招 | planner 活动,其他岗位还不存在 |
| **S2 招募** | 一次招满其他全部岗位,init → idle | 全员活动 |
| **某 agent 的工作阶段**(如 S3 之于 pm-ux) | 处理消息、产 artifact、propose | 该 agent 活动 |
| **某 agent 的非工作阶段** | idle,可被 @ / phase-change 唤醒;长时 idle(>5min)进 SIGSTOP | sleeping(CPU=0,内存留) |
| **S11 复盘** | planner 工作,其他 idle | 各自状态 |
| **S11 propose(done)** | orchestrator **统一释放全员**: SIGTERM → 归档 snapshot → `rm -rf` task 内 agents/ | 全部 terminated |

**唯一的非正常释放路径**: agent crash → 该岗位重 spawn(同岗位、新实例、displayName 重新抽签)。

**为什么这么设计**:
- lifecycle 模型只一个值,代码路径少,招/释/重招的复杂场景近乎为零
- 复盘时所有 agent 都还在,planner 可以直接 @ 谁问细节
- 资源占用由 SIGSTOP 控制(idle agent CPU=0),内存代价远小于"反复 spawn"的成本
- 释放只发生在两个明确点(task done / crash 重 spawn),无悬挂状态

### 5.9 orchestrator 不是 agent

orchestrator 是后端 Node 进程里的一段 **TS 状态机引擎**,不是 LLM 驱动。

- **职责**: 监听 `task_state_propose` → 查转移表 + 校验产出契约 → 通过则推进 + 广播 `phase-change` + 触发该态 hooks(招/释 agent、桌面通知)
- **校验粒度**(详见 §7):
  1. **文件存在**: 必交付物路径存在且非空
  2. **schema 检查**: artifact 类型正确;关键 section 不缺(如 `acceptance` 必须是表格、`design` 必须有"改动文件清单"段)
  3. **内容 lint**(可选): 对某些类型用小 LLM 检查"是否真的符合产出契约"
- **拒绝时**: 在 chatroom 发 `system-event: propose-rejected, reason: <哪条没过>` → 责任 agent 自行 retry
- **为什么不是 LLM**: 不可控(prompt injection 绕过门禁)、太贵(每次状态转移调 LLM 无意义)、毫秒级判定不应秒级延迟、不可审计

orchestrator 内部某些子任务(如"内容 lint")可以**选择性**调小 LLM,但状态转移本身规则化。

---

## 6. Agent Workspace 与 CLI 适配器 [详写]

每个 agent = **独立 workspace + CLI 子进程 + chatroom-mcp 连接**。workspace 让"工厂能力 = 只读基类、agent 实例 = 可变副本"成立,也让"释放 = `rm -rf`"得以干净执行。

### 6.1 Workspace 目录结构

```
<task-workdir>/agents/<agent-id>/      ← v0.3: agent workspace 落在 task 内
  .claude/
    settings.json              # 注入 PreToolUse/PostToolUse hooks + permissions
    skills/                    # 软链到全局 ~/.claude/skills/<skill>
                               # 运行时新装的 skill 直接落这,不污染全局
    agents/                    # 工厂指定的子 agent 类型(可选)
  mcp.json                     # 工厂指定 MCP + chatroom-mcp
  notes.md                     # agent 自己的 scratch
  factory.lock.yaml            # 招募时的工厂版本快照(供复盘 diff)
```

- `agent-id` 命名: `<factory>-<task-short>-<n>`,如 `engineer-ex23ab-01`(用于路径 / 后端引用)
- `displayName`: 从 `factory.defaultNamePool` 抽签的中国历史人名(如 "墨子");chatroom chip、消息流头像、dashboard 一律显示用

### 6.2 Spawn 流程(orchestrator 在 S1 招 planner / S2 招其余岗位时执行)

0. **抽签 displayName**: 从 `factory.defaultNamePool` 随机选一个**未被本任务使用过**的历史人名(如 `墨子`);用于 chatroom 展示
1. **生成 id**: `<factory>-<task-short>-<n>`,如 `engineer-ex23ab-01`
2. **建目录**: `mkdir -p <task-workdir>/agents/<id>/.claude/skills`
3. **软链 skill**: 工厂 `recommendedSkills` 中的每个 skill:
   ```bash
   ln -s ~/.claude/skills/<skill> <task-workdir>/agents/<id>/.claude/skills/<skill>
   ```
4. **写 mcp.json**: chatroom-mcp + 工厂 `requiredMcps` + 按 task 上下文选的 `optionalMcps`
5. **写 settings.json**: 注入 hooks(上报 context_log)+ permissions(**v0.5: 默认宽松**;allow list 含工厂 `recommendedCliTools` 的 bash 命名空间如 `Bash(docs-cli:*)`;MCP 工具按整命名空间放开如 `internal-cli.*`,不收紧到子命令)
6. **写 factory.lock.yaml**: 工厂版本 + 配置快照(含 displayName),供复盘 diff
7. **渲染 system prompt**: 工厂模板 + 注入变量(displayName / 岗位号 / task 信息 / 工作习惯)
8. **CLI spawn**:
   ```bash
   claude -p "<context-echo 触发语>" \
     --output-format stream-json \
     --append-system-prompt "<渲染后的 system prompt>" \
     --add-dir <task-workdir>/agents/<id> \
     --add-dir <task-workdir>/worktree \
     --mcp-config <task-workdir>/agents/<id>/mcp.json \
     --allowed-tools "<allow list,默认宽松;工厂 recommendedCliTools 对应 Bash 命名空间 + MCP 工具整命名空间>" \
     --denied-tools "<deny list,只挡明显危险的如 rm -rf / / sudo>"
   ```
9. **后端 hold 进程**: stdout 的 stream-json 解析为 `AgentEvent` 流;stdin 用于注入新人类/handoff 消息
10. **岗位状态**: `vacant → init → idle`,agent 拿到第一条 chatroom 消息后 → `working`

### 6.3 软链 vs Copy 取舍

- **软链好处**: 零拷贝、所有 agent 自动跟随全局 skill 更新、磁盘占用极小
- **软链坏处**: 跨工具 follow 不一致(macOS `realpath` vs `lstat` 差异);某些工具读软链触发权限警告

**MVP 策略**: 默认软链;M1 阶段实测 Claude Code CLI 是否正确解析 `.claude/skills/` 下的软链。若有问题切 copy(用 `rsync -a` + 工厂版本号判断是否需要重 copy)。

### 6.4 Hook 注入细节

每个 agent workspace 的 `.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": ".*",
      "hooks": [{
        "type": "command",
        "command": "/usr/local/bin/at-hook --agent <agent-id> --phase pre"
      }]
    }],
    "PostToolUse": [{
      "matcher": ".*",
      "hooks": [{
        "type": "command",
        "command": "/usr/local/bin/at-hook --agent <agent-id> --phase post"
      }]
    }]
  }
}
```

`at-hook` 是个轻量二进制(我们自己写),把 tool 调用元信息 POST 到后端的内部 endpoint(不走 MCP 工具调用,避免污染 chatroom),后端聚合为 `context_log`。agent 自己不感知,但前端 dashboard 拿到完整资源访问轨迹。

### 6.5 CLI 适配器接口

```ts
interface CliAdapter {
  name: string                                  // "claude" | "codex" | ...
  capabilities: AdapterCapabilities
  spawn(opts: SpawnOpts): Promise<AgentHandle>
}

interface AdapterCapabilities {
  supportsSkills: boolean
  supportsMcp: boolean
  supportsHooks: boolean
  supportsAddDir: boolean
  supportsStreamJson: boolean
  supportsAppendSystemPrompt: boolean
}

interface SpawnOpts {
  agentId: string
  workspacePath: string                         // ~/.agent-team/agents/<id>/
  taskWorktreePath: string                      // ~/.agent-team/projects/.../worktree/
  systemPrompt: string                          // 工厂模板渲染后
  initialMessage: string                        // 给 -p 的内容,如 context echo 触发语
  skills: string[]
  mcpConfigPath: string
  hooksConfigPath: string
  allowedTools?: string[]
  deniedTools?: string[]
  model?: string
}

interface AgentHandle {
  id: string
  pid: number
  state: 'spawning' | 'active' | 'idle' | 'offline' | 'terminated'
  events$: AsyncIterable<AgentEvent>
  send(msg: string): Promise<void>              // 走 stdin 续聊
  pause(): Promise<void>                        // SIGSTOP
  resume(): Promise<void>                       // SIGCONT
  kill(): Promise<void>                         // 释放并 cleanup workspace
}
```

- **claude 适配器**: `claude -p ... --output-format stream-json --add-dir ... --mcp-config ... --append-system-prompt ...`;hooks 走 `<workspace>/.claude/settings.json`,Claude Code 自动识别
- **codex 适配器**: `codex exec ...`(按 codex CLI 真实参数对齐);MCP 走 codex 自己的 config 路径;hooks 若 codex 不支持则 fallback 到包装脚本(在 codex 调用前后 wrap)
- **能力差异处理**: 工厂可声明 `requiresCapabilities`,招募时按适配器 `capabilities` 检查兼容;不兼容直接报错,planner 重选

### 6.6 进程生命周期 / 池化

- **并发上限**: 全局默认 8 个活跃 CLI 进程,可调;超过排队
- **idle 自动 sleep**: agent 长时间 idle(> 5 min)→ 后端 SIGSTOP 暂停(内存留、CPU 0%);收到 mention/phase-change → SIGCONT 复活
- **保活心跳**: 后端每 30s 检查活进程 pid 健康度;异常视为 `offline` → 触发岗位重招(详见 §7.3)

### 6.7 释放策略(v0.3: 只在两类时机)

**正常释放 — S11 propose(done)**:
1. orchestrator 对所有 agent 发 SIGTERM,30s 不退则 SIGKILL
2. 归档每个 agent 的 `factory.lock.yaml` + skill diff(实际安装 vs 工厂模板)到 `<task-workdir>/retro/agent-<id>-snapshot/`
3. 持久化最后一次 transcript snapshot(完整 chatroom 已经在 `chatroom.jsonl`,这是冗余备份)
4. **agents/ 目录不删**,作为 task 归档的一部分保留;只清理活进程

**异常释放 — agent crash**:
1. 标记该 agent `state=terminated`,岗位 `working/idle → vacant`
2. 归档 crash 时刻快照(同上 step 2-3)
3. orchestrator 从工厂模板**重 spawn** 一个新实例:**新 agent-id、新 displayName 抽签**;通过 `chatroom_recent` + `artifact_list` 重建上下文,**不沿用 crash 实例的 transcript**
4. 岗位 `vacant → init → idle`,继续工作

**任务 abort**(人类主动杀):
1. 同正常释放的进程清理
2. 不做复盘
3. task 标记 `aborted`,目录保留

### 6.8 任务级 MCP 注入(v0.4 引入,v0.5 简化)

**为什么**: 不同任务对外部资源的需求差异大 —— 内网 bugfix 可能需要 `internal-cli`,OSS 项目可能用不到。工厂层默认配置不该一刀切。所以**任务级动态注入**。

典型例子: `internal-cli` 通过 `internal-cli mcp` 启动 stdio MCP server,把全套内网平台命令暴露给 agent;**agent 自己挑用哪个**(v0.5: 不再强制 `--allow-domains`)。

**机制**:

1. **planner 在 S1 建议**: 看任务上下文(issue-tracker 链接 / 公司内网 wiki / 内部代码仓 仓引用),为相关岗位填 `mcpInjections`(用户在前端可改):

   ```yaml
   # 在 task-plan.md 的 seatPlan 部分
   seatPlan:
     - seatId: pm-1
       role: PM
       factory: pm-ux
       mcpInjections:
         - name: internal-cli
           command: internal-cli
           args: [mcp]                       # v0.5: 不传 --allow-domains,agent 自决用哪个子领域
       rationale: "需求源在 issue-tracker + 公司内网 wiki"
     - seatId: eng-1
       role: Engineer
       factory: engineer
       mcpInjections:
         - name: internal-cli
           command: internal-cli
           args: [mcp]
       rationale: "改 example-app 仓 + 查内部知识"
     # qa / anti / ci 若不涉及内网则不填 mcpInjections
   ```

2. **orchestrator spawn 时 merge**(§6.2 step 4 的扩展):
   - 工厂的 `coreMcps[]`(`chatroom-mcp` 等)+ `recommendedMcps[]`(经用户增删后)
   - **merge** 该 SeatSpec 的 `mcpInjections[]`(name 重复时,以 task 注入为准)
   - 写入 agent 的 `mcp.json`
   - 同时解析模型配置: `SeatSpec.modelOverride` → `Factory.preferredModelProfile` → `Factory.fallbackModelProfiles[]` → 开发期环境 fallback → `claude-acp` 默认；该结果写入 agent model profile 快照
   - 创建 agent 时先做轻量 prompt 探针；若 provider/package 存在但账号 limit/auth/model 不可用，立即销毁临时 session 并尝试下一个 fallback
   - 运行中遇到 quota / usage-limit 时，seat 进入 `switching`，chatroom 记录切换说明，旧 agent terminated，新 agent 使用下一个 model profile 接管
3. **agent 视角**: 启动后看到 `internal-cli.<subdomain>.<command>` 一系列结构化工具,自己挑需要的调
4. **permission**(v0.5 宽松): orchestrator 默认把整个 `internal-cli.*` 命名空间加入 allowed-tools;若用户要收紧,在前端工厂 permission 字段显式写

**校验** (v0.5 简化):
- propose `S1→S2` 时校验 seatPlan schema(`seatId / role / factory` 必填,`mcpInjections` 可选)
- **删除** v0.4 的"任务含内网关键词但没注入 internal-cli → warning"(planner 自己判断,系统不预设规则)

**好处**:
- **不耦合**: 工厂模板干干净净,内外网任务用同一模板
- **简单**: agent 自决用哪个子领域,planner 不必预测;减少 over-engineering
- **透明**: 每招一个 agent 都能从 task-plan 看到为什么这个 agent 有这些工具
- **复盘可见**: `factory.lock.yaml` 含 mcpInjections,复盘时 review 注入是否合理

**反例**: 不要在工厂模板里默认挂 internal-cli。v0.3 曾把 `internal-cli` 列为 pm-ux 工厂的 `recommendedCliTools` 必装 —— OSS 任务也会带上,产生不必要耦合;v0.4 已修正。

---

## 6A. Task Bootstrap / Resource / Release(v0.6 task-bootstrap-lifecycle)

把"准备工作区 / 持有副作用 / 收尾资源"这三件原本散落在 planner skill 和 task done 钩子里的事,**产品化为 orchestrator 一等责任**。Planner 不再调 `sw`,前端也不在每次创建 task 表单里勾 worktree。

### 6A.1 职责边界

| 关注点 | 归属 | 不归属 |
|---|---|---|
| 建 git worktree / 复用 pnpm node_modules / 拉 env | `TaskBootstrapRunner` + provider (`generic-pnpm` / `sw` adapter) | planner / engineer / 任何 agent skill |
| worktree path / branch / status 的权威态 | task DB `resources` 表(经 `task_resource_get` MCP / WS event 暴露) | factory yaml / planner prompt / hard-coded `<workdir>/worktree` 路径 |
| Agent spawn 的 `--add-dir <worktree>` | `spawnAgent` 从 ready resource 派生 | planner 在 prompt 里硬写 |
| 收尾(retrospective / archive-plan / worktree 终态) | `releasing` 阶段:planner 写文档 + release provider 给事实 + orchestrator 终态化 | done 按钮直接 kill 全员 |

### 6A.2 Bootstrap provider 程序契约

Provider 必须提供机器可调用入口(不仅 `SKILL.md`),实现 `prepare / status / release`:

```ts
interface BootstrapProvider {
  prepare(input: { taskId, taskWorkdir, repoRoot, mode }): Promise<TaskBootstrapResource>
  status(input: { resourceId }): Promise<TaskBootstrapResource>
  release(input: { resourceId, policy }): Promise<TaskBootstrapResource>   // → retained|removed|archived|needs-review
}
```

第一版内置:

- **`generic-pnpm`**:`git worktree add -b <branch>` + `initializePnpmWorktreeDeps` (lean 复用 root/package node_modules + git exclude);任何 pnpm monorepo 通用,默认 provider。
- **`sw` adapter**:子进程调全局 `sw` CLI,把人类文本输出规范化成 `TaskBootstrapResource` JSON;example-app dogfood 用,**不重写 sw 核心逻辑**。

### 6A.3 默认配置存储

服务首次启动扫项目 skill 入口发现可用 provider;前端选定后写入:

```
~/.agent-team/projects/<projectId>/bootstrap.yaml
  provider: generic-pnpm | sw | none
  mode: lean | full
```

不放 index DB(架构师 D 决策:每项目独立 yaml 便于人手编辑 / git 跟踪 / 用户机器迁移)。

### 6A.4 Release 默认保守

Worktree release 不等于 delete。默认 `retained`;只有 provider 能证明 `clean + branch merged` 才 `removed`;不确定即 `needs-review`,planner 在 `retro/archive-plan.md` 写原因。Done 校验门禁要求所有 resource 进入明确终态,但 `retained` / `needs-review` 也算明确终态,不阻塞 done。

### 6A.5 与 spawn / gate 的关系

- planner cwd 是 agent workspace + task planning home,**不依赖 worktree**,所以 bootstrap creating/failed 时 planner 照常进 S1
- engineer/qa/ci spawn 前由 `BootstrapGate.waitForReady()` 阻塞,直到 primary worktree resource = ready;`additionalDirectories` 含 worktree path + gitdir/commondir
- bootstrap failed 时前端展示 retry 入口,retry 复用同一 resource id,只递增 attempts

### 6A.6 与 OpenSpec planning home 的关系

Planner 的 OpenSpec change 写到 `~/.agent-team/projects/<projectId>/tasks/<taskId>/openspec/changes/<change>/`(task 管理空间,而不是业务 worktree),避免污染业务 branch、并支持 no-worktree task。Engineer 的源代码改动仍只能落在 ready worktree。

---

## 7. chatroom-mcp 设计 [详写]

### 7.1 为什么是 MCP server

- 所有 agent 都是 CLI 子进程,**给 CLI 加自定义工具**最干净的方式就是 MCP server
- 同一份 chatroom-mcp 二进制可挂到任何 CLI(claude/codex 都支持 MCP)
- 后端拿到 MCP server 的 stdio 端,既是 tool provider 也是 event sink

### 7.2 工具列表(契约)

#### 通信类

```
chatroom_send(channel, type, content, refs?, mention?, replyTo?)
  - channel: "main" | "eng-internal" | "tool-traces" | "mentions"
  - type: "text" | "handoff" | "question" | "status" | "phase-notice"
  - content: string (markdown)
  - refs: artifact path[] (引用,不复制内容)
  - mention: seatId[]                        # mention 的是岗位,不是工厂名
  - 路由(v0.3):
    - 岗位 idle/working: 直接路由,目标 agent 在 listen 上收到
    - 岗位 offline (SIGSTOP):后端 SIGCONT 唤醒 → 转 idle/working,然后路由(透明)
    - 岗位 vacant (crash 重 spawn 中):消息入 seat.queue,新实例 ready 后回放
  - 返回: { messageId, ts, queuedSeats?[] (vacant 时报告) }

chatroom_listen(channel, since?, timeoutMs?)
  - 长轮询: 阻塞最多 timeoutMs (默认 30s),期间有新消息立即返回
  - since: 上次拿到的 messageId,服务端切片
  - 返回: Message[]

chatroom_recent(channel, n=20)
  - 拉最近 n 条(便于 agent 入场拿上下文)
  - 返回: Message[]
```

#### 岗位类 (v0.2 新增)

```
seat_create(taskId, role, factory)
  - planner 在 S1 编排 seatPlan 时调用
  - 创建一个状态为 "vacant" 的岗位,等待 orchestrator 招募
  - 返回: { seatId }

seat_list(taskId)
  - 列出所有岗位 + 当前状态 + 占据 agent
  - 返回: Seat[]

seat_status_get(seatId)
  - 返回: { status, agentId?, queueLen, lastActivity }

seat_terminate(seatId, reason)
  - v0.3: 正常情况不主动调;task done 时由 orchestrator 统一释放全员
  - 仅在 ① 人类前端点 "释放该岗位"  ② task abort  时调用
  - 杀掉占据它的 agent,清空 queue
```

#### 任务状态类

```
task_state_get(taskId)
  - 返回: { state, history, dashboard, currentPhase }

task_state_propose(taskId, targetState, evidence)
  - agent 声明"我交付了,可以进入下一态"
  - evidence: { artifacts: artifactId[], notes?: string }
  - orchestrator 校验产出契约后接受 / 拒绝(校验粒度见 §7.4)
  - 返回: { accepted, reason?, failedChecks?[], newState? }
  - 权限: 每个 agent 只能 propose 工厂 permission 允许的转移(见 §5.4)

subtask_create(taskId, parentId?, title, assigneeSeat, deps?)
  - engineer 在 S4 编排 tasks.md 时调用,把子任务也注册到系统
  - assigneeSeat 指岗位 id (不是工厂名)
  - 返回: { subtaskId }

subtask_update(subtaskId, status, progress?, note?)
  - status: "pending" | "in-progress" | "blocked" | "done"
  - 更新后 dashboard tab 实时刷新
```

#### 制品类

```
artifact_register(taskId, path, type, producer, summary, refs?)
  - agent 产出物登记;前端"文档" / "files" tab 数据源
  - producer = agentId
  - 返回: { artifactId }

artifact_list(taskId, type?, producer?)
  - 列任务下的制品
  - 返回: Artifact[]

artifact_get(artifactId)
  - 读制品内容(实际是读 path 文件)
```

#### 观察类(供 dashboard "上下文关联"区)

```
context_log(taskId, agentId, action, ref, ts)
  - 由 hook(PreToolUse/PostToolUse,见 §6.4)自动上报
  - action: "read-file" | "websearch" | "webfetch" | "run-cmd" | "mcp-call" | "skill-load"
  - ref: 资源标识(文件路径 / URL / 命令 / MCP tool name)
  - agent 不主动调,hook 代办
```

#### 协作类

```
handoff(fromAgentId, toSeat, message, refs)
  - 显式交接(比 mention 更正式,会触发 system-event)
  - 例: pm-ux 完成 S3 后 handoff 给 engineer 岗位
  - 若 toSeat offline/vacant: 入 queue + 给 orchestrator 信号"是否要重招"
```

### 7.3 岗位机制(Seats)

planner 在 S1 出 `seatPlan` 时声明任务需要几个**岗位 (Seat)**;每个岗位绑一个工厂。chatroom 内的所有协作以岗位为单位呈现 —— 即使一个工厂招了多个实例(并发的 engineer),也是同一个岗位下的多实例。

**Seat 状态机**(v0.3: idle ↔ offline 是 SIGSTOP 的正常子态;vacant 只来自 crash):

```
        seat_create
            ↓
        [vacant] ◀──── agent crash (SIGKILL/异常退出)
            ↓ orchestrator 自动重 spawn(从工厂模板,新 displayName)
         [init] ── spawn 完成 ──→ [idle]
                                      ↕   收到 mention / phase-change 唤醒
                                  [working]
                                      ↓ 长时 idle(>5min)→ 后端 SIGSTOP
                                  [offline] (queue 累积 mention)
                                      ↑ 来消息 → 后端 SIGCONT → idle/working(透明)
                                 (task done → [terminated],唯一正常出口)
```

**v0.3 关键变化**:
- `offline` 不再是"丢失",是 SIGSTOP 暂停的**正常 idle 子态**,后端 SIGCONT 即恢复,对发送方透明
- `vacant` 只在 crash 时短暂出现,orchestrator 自动重 spawn 补位
- 岗位状态不会卡在 `vacant`(除非招募失败,告警人类)
- 整个 task 期间,正常情况下岗位永远不消失

**Mention 路由细节**(对应 §7.2 `chatroom_send` 的路由规则):

- planner 可以 @ 任何岗位;orchestrator 可基于 phase-change 主动唤醒
- 用户从前端 @ 岗位走同一逻辑
- vacant 状态(crash 重 spawn 间隙)的消息进 queue,新实例 ready 后**完整回放**给它

**前端展示**: chatroom 顶部岗位 chips 条,显示**历史人名 + 角色 + 状态点**(如 `墨子(engineer) 🟢` / `诸葛亮(planner) 🟢` / `包拯(qa) 💤`),色块: 🟢 working / 🔵 idle / 💤 offline(SIGSTOP)/ ⚪ vacant(crash 中);点击 chip 展开操作(查 transcript / 强制重招 / 释放该岗位)。

### 7.4 task_state_propose 校验粒度

orchestrator 收到 propose 后按以下三层校验,任何一层失败都拒绝:

**Layer 1: 文件存在 (硬校验,规则化)**
- 检查工厂 `deliverables` 中所有 required artifact 是否在 task 目录下存在
- 文件非空(size > 0)
- 失败 reason 示例: `"acceptance.md not found at pm-ux/acceptance.md"`

**Layer 2: Schema 检查 (硬校验,规则化)**
- 每个 artifact 类型有固定 schema(在工厂 `deliverables[].schema` 声明)
- 例:
  - `acceptance`: 必须包含 markdown 表格,且至少有 1 行非表头数据
  - `design`: 必须包含 `## 改动文件清单` section
  - `verification_report`: 必须包含所有 acceptance 条目的状态(✅/❌/⚠️)
- 用 markdown AST 解析 + 简单 lint 实现,毫秒级
- 失败 reason 示例: `"design.md missing required section '改动文件清单'"`

**Layer 3: 内容 lint (软校验,可选,LLM)**
- 对某些类型用小 LLM(Haiku)检查"内容是否真的符合产出契约":
  - acceptance: 每条标准是否真的"可机验"(有触发条件 + 预期结果 + 验证方式)
  - verification_loop: 修复方案是否包含具体文件:行号
- 工厂可选启用 Layer 3(`deliverables[].contentLint=true`)
- LLM 给出 confidence + 建议;低 confidence 时仍可通过(避免假阴性卡住流程),但记入"软警告"在 chatroom 提示

**拒绝时**:
- chatroom 发 `system-event: propose-rejected`,内容 = `{failedChecks: [...]}`
- 责任 agent 收到后自行决定是否 retry / 改 artifact 后重 propose

### 7.5 实现要点

- **进程模型**: chatroom-mcp 是后端进程内嵌的 MCP server,通过 **每个 agent 独立 stdio 隧道** 暴露给 agent CLI(MCP spec 标准用法)
- **后端单进程**: 后端统一 orchestrator + chatroom-mcp,内部用消息总线连接;**不要**为每个 agent 起独立 server 进程
- **持久化**: SQLite WAL 模式存元数据(消息索引 / 状态 / dashboard / seats);消息本体走 `chatroom.jsonl` append-only(事后审计)
- **Listen 实现**: SQLite trigger / 内存事件总线 → 唤醒等待的 long-polling 连接
- **并发安全**: 状态机转移用乐观锁(version 字段),失败重试
- **WebSocket 推送**: 后端把所有 chatroom 事件透传给前端 WS,前端不直接调 MCP
- **路由权限**: 每个 agent 持有 token,token 决定能调哪些工具 + 能 propose 哪些状态转移(见 §5.4 权限表)
- **Hook 注入**: 详见 §6.4

### 7.6 同步语义示例

**场景**: pm-ux 完成 S3,要交给 engineer。

1. pm-ux 调 `artifact_register` × 3(proposal/acceptance/visual-contract)
2. pm-ux 调 `chatroom_send(main, "handoff", "3 份文档已落,可以开始 S4 了", refs=[3 个 artifact])`
3. pm-ux 调 `task_state_propose(taskId, "S4", evidence={artifacts:[3 个 artifact id]})`
4. orchestrator 三层校验:
   - Layer 1: 3 个文件都存在 + 非空 ✅
   - Layer 2: 3 个 schema 都通过(proposal 有"用户故事"段、acceptance 是表格、visual-contract 有状态矩阵)✅
   - Layer 3(若启用): Haiku 看 acceptance 是否真的"可机验" ✅
5. 接受 → 推进到 S4 → 广播 `phase-change`
6. engineer 在 listen 上收到 phase-change,触发其工作流入口
7. engineer 调 `chatroom_recent(main, 50)` + `artifact_list(taskId, type='proposal'|'acceptance'|'visual-contract')` 拉上下文
8. engineer 开始 S4 工作;pm-ux 岗位 `working → idle`(进 SIGSTOP,workspace 保留);**task done 才统一释放**;pm-ux 后续如被 qa @(比如对验收标准歧义)→ SIGCONT 唤醒回 idle 响应

整个过程**无中央调度循环**: orchestrator 只在收到 `task_state_propose` 时介入,其他时间 agent 自己异步推进。

---

## 8. 前端信息架构 [提纲]

> v0.2 按用户草图重画: **三栏布局**(左项目+工厂 / 中 chatroom / 右 task tabs);右栏可折叠;"阶段"和"上下文关联"并入 `dashboard/` tab。

### 8.1 主视图布局

```
┌─────────────────────────────────────────────────────────────────────┐
│ ① 项目栏 [+]     │ ② chatroom 主区             │ ③ task tabs    [折] │
│                  │   chatroom for task         │  ────────────────  │
│ 📁 example-app         │                              │  agents/           │
│  ├─ task-A 🟢   │   ⭕ agent A                │  files/            │
│  ├─ task-B 🟡   │   ─────────                  │  dashboard/        │
│  └─ task-C 🔴   │                              │                    │
│                  │   ⭕ agent B                │                    │
│ ─────────────── │   ─────────                  │                    │
│                  │                              │                    │
│ 🏭 factories     │   (消息流 + 频道切换)        │                    │
│  • planner       │                              │                    │
│  • pm-ux         │                              │                    │
│  • engineer      │                              │                    │
│  • qa            │                              │                    │
│  • anti          │  ┌──────────────────────┐    │                    │
│  • ci            │  │ chat-input  @<seat>  │    │                    │
│                  │  └──────────────────────┘    │                    │
└─────────────────────────────────────────────────────────────────────┘
   18%                   62%                            20% (可折叠)
```

### 8.2 左栏(项目导航 + 工厂管理)

- **项目区**: 列出所有项目,展开看 task 列表;`+` 按钮创建项目 / 新 task(新 task = 进 S0 任务首页表单)
- **task 列表**: 每条显示标题 + 状态 chip(`S3` / `S6` / `S10` / ...);点击切到该 task chatroom
- **factories 区**: 6 个工厂列表,点击进**工厂管理页**(人设 / skill / MCP / permissions / 版本历史 / 调优队列)
- **顶部"项目"标签 + `+`**: 创建新项目(指定 repoPath,默认继承全局工厂集)

### 8.3 中栏(chatroom 主区)

- **顶部岗位条**: chips 列出 task 所有岗位,**显示历史人名 + 工厂副标签 + 状态点**(如 `墨子<engineer> 🟢` / `包拯<qa> 💤` / `诸葛亮<planner> 🔵`);点击展开操作菜单(`@` 路由 / 查 transcript / 查 workspace / 强制重招 / 释放该岗位)
- **消息流**(实时 WS):
  - `agent-tool-call` 默认折叠,展开看 tool 名 + 参数 + 结果
  - `phase-change / handoff / propose-rejected / human-msg` 用显著分隔卡片
  - artifact 引用(refs)是可点击卡片,点击跳到 `files/` tab + 预览
  - 头部下拉切换频道(`main / eng-internal / tool-traces / mentions`)
- **底部 chat-input**:
  - 输入框 + `@<seat>` 选择器(从岗位条选)
  - 默认 `@` planner(用户的 PM 接口);可手动改成任何在线岗位
  - 引用消息按钮(reply-to)+ 文件附件

### 8.4 右栏(task tabs,可折叠)

按用户草图三个 tab:

- **agents/**: 当前 task 下所有 agent 实例;每个 agent 卡片显示:
  - 头像(按工厂着色)
  - **历史人名**(大字,如"墨子")+ 工厂副标签 + agent-id(小字,如 `engineer-ex23ab-01`)
  - 岗位 + 状态(🟢 working / 🔵 idle / 💤 offline / ⚪ vacant)
  - 已加载 skill 列表 + 运行时新装的 skill(**diff vs 工厂模板**)
  - 已用 CLI tools(从 context_log 聚合,如 `internal-cli × 5 / docs-cli × 12`)
  - 最近一次活动时间
  - 点击进入 agent 详情: 完整 transcript + workspace 文件浏览 + 该 agent 产出的 artifact 列表
- **files/**: task 目录下所有 artifact;按目录树展示(`plan/ pm-ux/ eng/ qa/ anti/ ci/ retro/`):
  - 点击预览 markdown
  - 显示 producer + 创建时间 + size
  - **与消息流双向锚定**: 点击 artifact 跳到登记该 artifact 的消息;消息中的 refs 卡片跳回这里
- **dashboard/**(整合: 阶段 + 子任务 + 上下文关联):
  - **状态机进度**: 12 态可视化(S0..S11),当前态高亮,历史卡顿点(在某态停留时长 > 阈值)标注
  - **子任务表格**: 状态 / 进度 / 负责岗位 / 依赖图,带进度条
  - **上下文关联**: 按 agent 分组的资源访问记录(文件 / URL / 命令 / MCP call);可按时间 / 类型筛(MVP 可先留空)

### 8.5 其他页面

- **任务首页表单(S0)**: 新建 task 时弹层 / 全屏表单:
  - 标题(必填)
  - 类型(下拉: bugfix / feature / refactor / other)
  - 描述(markdown)
  - 上下文链接列表(动态加行,自动识别 issue-tracker/figma/内部协作平台 URL → 给出可解析的提示)
  - "开始"按钮(disabled 直到至少 1 条链接 + 描述非空)
- **工厂管理页**: CRUD 工厂定义,版本化
  - `recommendedSkills` / `recommendedCliTools` / `recommendedMcps` / `workingHabits` 字段**全部可任意增删**(v0.5 强调:这是工厂"推荐",不是必装)
  - `coreMcps`(架构必装如 `chatroom-mcp`)字段**不可删**,前端标灰锁定 + tooltip 解释"没它整套机制不工作"
  - `defaultPermissions` 字段可显式调宽紧(v0.5 早期默认宽松,迭代中可收紧)
  - 支持从复盘建议导入"调优 patch"(高亮与当前版本的 diff)
  - 工厂版本化:每次保存版本 +1,可回滚到任意历史版本
- **复盘视图**(任务归档后):
  - 展示 `retrospective.md`,按 "✅ 做得好 / ⚠️ 做得不好 / 💡 优化建议 × 工厂" 分区
  - 每条建议下有 "**入项目知识库**" 复选框,人类勾选后才入库(避免污染)
  - **按 agent 看 transcript** 入口: 任意时刻可点 "📜 看某 agent 的对话流",查看该 task 内某个 agent(如 "墨子")的完整对话;归档后仍可访问(transcript 保留在 task 内)
  - **能力 diff 卡片**: 展示该任务下各 agent 实际加载的 skill 与工厂模板的差异(运行时新装了什么、用了几次 CLI tool),作为下一次工厂调优的客观依据

### 8.6 设计要点

- **三栏比例**: 左 18% / 中 62% / 右 20%;右栏可折叠为图标条(草图箭头)
- **桌面通知**: 任务进入 S10 ready2merge 时,弹浏览器 Notification(取代旧通讯员);点击通知 → 跳到该 task chatroom + dashboard 自动切到 ci-issues 摘要视图
- **离线表现**: 后端断开时前端顶部 banner;chatroom 进入只读;岗位条所有 chip 灰化
- **多任务并行**: 支持多 tab 同时打开不同 task chatroom(浏览器多 tab),共享一个 WS 连接

---

## 9. 复盘与反哺机制 [提纲]

> v0.2: **复盘由 planner 做**(planner `alwaysOn` 一直活到 S11),不再设独立 retro 工厂。**项目级知识库入库由人类判定**。

- **触发**: 人类在 S10 点 "完成" → 状态进入 S11 → 唤醒 planner 启动复盘流程
- **复盘输入**:
  - 完整 chatroom transcript(原始 jsonl)
  - 任务目录全部 artifact(`plan / pm-ux / eng / qa / anti / ci`)
  - 状态机轨迹(每个 phase-change 的时间戳)
  - 各 agent 的 `factory.lock.yaml` 快照(看运行时是否装了非默认 skill,作为工厂能力建议依据)
- **输出**: `retro/retrospective.md`,固定结构:
  - **任务概要**: 类型 / 复杂度估计 / 总耗时 / 通过 anti R2 用了几轮
  - **阶段时长分布**: 哪一步卡得最久?是 agent 慢、人类响应慢、还是反复回打
  - **工厂维度**(per-factory):
    - ✅ 做得好(具体行为 + chatroom 消息引用)
    - ⚠️ 做得不好(具体问题 + chatroom 消息引用)
    - 💡 优化建议(对工厂 `systemPromptTemplate` / `workingHabits` / `recommendedSkills` 的具体修改)
  - **协作维度**:
    - 谁等谁(发起 mention → 响应时长)
    - 信息错配(handoff 后下游再问的次数)
    - 卡顿点(状态机停留过长 / propose 多次被拒)
  - **制品质量自评**: 对比 acceptance 是否真验完了所有条目
  - **可量化指标**: anti R1/R2 各找到 blocker 数 / qa loop 次数 / CI issue 路由次数 / 阶段时长 P50/P90
- **反哺路径**:
  1. 每条 💡 建议入"**工厂调优队列**"(后端表)
  2. 人类在前端工厂管理页审阅(显示与当前版本 diff 预览)
  3. 采纳 → 工厂相应字段更新 + 版本 +1
  4. 不采纳 → 标记 `dismissed`,记原因(供后续判定是否重提)
- **项目级知识库**:
  - 位置: `~/.agent-team/projects/<project>/knowledge/`
  - 内容: 跨任务沉淀的"风格指南 / 常见踩坑 / 组件清单 / 技术决策" 等
  - **入库由人类判定**: 复盘报告里每条 "💡 建议" 或 "📌 沉淀" 都有 "**入项目知识库**" 复选框;**勾选才入库**,避免单次任务的偶发噪声污染长期知识
  - 新任务招募时,planner 把知识库摘要选择性注入到 system prompt
- **复盘完成**: planner 调 `task_state_propose(S11→done)` → orchestrator 释放所有 agent + 标记 task 归档

---

## 10. MVP 切片 [提纲]

按 "先证明最难的事,再铺开" 的原则。v0.2 调整: **删 `comm`**、**复盘改 planner 触发**、首阶段就上 **`sw` skill** worktree 方案、岗位机制在 M3 完整化。

### M1 (~2 周): 最小骨架可观察

- **后端**: Node + chatroom-mcp(实现 `chatroom_send/listen/recent` + `artifact_register/list` + `seat_*` 基础)+ **claude 适配器**(含 agent workspace + hooks)
- **基础设施**: `~/.agent-team/` 目录骨架;`sw` skill 起 worktree
- **前端**: 三栏布局极简版(项目栏 / chatroom / agents+files tab);任务首页 S0 表单
- **工厂**: 只做 `planner + engineer`,**全部 `alwaysOn`**(v0.3 默认)
- **状态机**: S0 / S1 / S2 / S6 / S11;S2 一次招满
- **命名**: agent displayName 从工厂 `defaultNamePool` 抽签,前端 chip 显示"诸葛亮 / 墨子"
- **验收信号**: 一个真实 example-app bugfix 跑通 —— 人类发起 → planner 多轮对齐 → spawn engineer → engineer 在 chatroom 对话 + 改代码 + commit → planner 出复盘文档

### M2 (~2 周): 多 agent 并发协作

- 加 `qa` 工厂、`ci` 工厂;状态机补 S7 / S8(简化版,不强制 anti)/ S9 / S10
- chatroom-mcp 补 `task_state_propose` 三层校验 + `handoff` + `subtask_*`
- 桌面通知 hook(ready2merge 触发 Notification)
- **验收信号**: 同一 task 下 planner+engineer+qa+ci 4 个 agent **真的并发**(不是串行轮转);qa 失败 → 回 S6 → 重过的闭环跑通;ci 路由问题回 engineer 跑通

### M3 (~3 周): 全流程

- 加 `pm-ux + anti` 工厂(完整 6 工厂)
- 状态机补 S3 / S5(可选 R1)/ S8 完整 anti R2 + 3 次死循环上限
- **岗位机制完整**: idle↔offline 走 SIGSTOP / vacant 仅 crash / 前端 chips 显示历史人名 + 状态点
- **按需 MCP 注入**(v0.4): planner 在 task-plan 里声明 `seatPlan[].mcpInjections`;orchestrator spawn 时 merge 进 agent 的 mcp.json
- 前端补 `dashboard/` tab(状态机进度 + 子任务 + 上下文关联)
- `ui-impl` skill + `docs-cli` bash + docs 取数 skill 系列 + `Playwright MCP` 接入;**`internal-cli` MCP 作为按需注入示例跑通一次**(只对 pm-ux + engineer 注入,qa/anti/ci 默认不挂)
- **验收信号**: 一个真实 example-app 需求(含 Figma + issue-tracker)从 planner 到 ci 全自动跑完,人类只在 S0 输入 + S10 确认两个点介入

### M4 (~2 周): 复盘 + 工厂调优 + 知识库

- planner 复盘流程 + `retro/retrospective.md` 生成
- 工厂调优队列 + 工厂管理页(版本化 + diff 预览 + 采纳/拒绝)
- 项目知识库目录 + 人类入库勾选 UI
- chatroom 压缩(钉选 + 滚动摘要,见 §11)
- **验收信号**: 同类型任务跑两次,第二次工厂 prompt 已被前一次的建议改过且效果可见

### M5 (~1 周): codex 适配器 + 多模型

- 实现 codex 适配器(`capabilities` 声明 + spawn 等价行为)
- 工厂可配置 `preferredAdapter`
- **验收信号**: 同一工厂从 claude 切到 codex 跑同一任务,产出物结构等价

### 各阶段共通验收前提

- 架构文档 / PR 描述完整
- 一个真实 example-app task 端到端跑通,不是 demo + mock
- 失败路径覆盖(任务暂停 / agent crash / propose 拒绝)有手工验证

### 迁移策略 — task-bootstrap-lifecycle (v0.6)

- **早期项目可 break change**:本仓库 dogfood 模式,引入 `releasing` 状态 + `resources` 表是 forward-only。
- **历史任务无 resource 行**:在 v0.6 之前创建的 task 进入 done 时不经过 `releasing`;前端 / API 把它们的 resource 列表标注为 `unknown` / `legacy`,不做复杂回填。
- **bootstrap.yaml 缺失**:服务首启发现 provider 写入默认;若用户删除 yaml,新 task 当作 `provider: none` 处理(planner 可起,代码岗位 gate 阻断)。
- 不维护"旧路径直接 mkdir 空 worktree"的兜底:旧行为已被 D1 (orchestrator 程序入口) 取代。

---

## 11. Chatroom 压缩方案 [详写]

长任务 chatroom 消息无限增长,新 agent 入场拿全量会爆 token。社区主流四种方案对比:

| 方案 | 原理 | 优 | 劣 | 适用 |
|---|---|---|---|---|
| 滑动窗口 | 只保最近 N 条 | 简单 / 便宜 | 丢早期决策 / 任务初衷 | 短任务 |
| 关键消息钉选 | 最近 N + 标记重要 | 重要信息不丢 | 普通消息累积爆 | 中任务 |
| 滚动摘要 | 超阈值用小 LLM 压缩 | 总长可控 | 摘要失真 + 成本 | 长任务 |
| 分层 RAG | 全存按检索喂入 | 完美保真 | 工程量大 + 检索质量决定一切 | 复杂并行 |

### 11.1 采用方案: 钉选 + 滚动摘要 混合

#### Layer 1 — 钉选(永久保留原文)

以下类型消息**永久保留**,不参与摘要,新 agent 入场原文喂入:

- `human-msg` —— 人类发言
- `phase-change` —— 状态机切换
- `handoff` —— 显式交接
- `artifact-event` —— 制品登记
- `propose-rejected` —— 校验失败(作为故障历史)
- 标记 `decision=true` 的消息 —— agent 自己声明"这是决策"
- 任何 @ planner 或 planner 发出的消息(协调链保留)

#### Layer 2 — 滚动摘要(普通对话累积压缩)

- **触发阈值**: 普通消息(非钉选类)累积超过 **100 条**
- **压缩动作**:
  - 取最早一段 50 条普通消息
  - 调小 LLM(Haiku 级)摘要为 ≤ 200 字
  - 摘要落 `chatroom.summary.jsonl`(append-only),每条带时间区间
  - 原 50 条仍保留在 `chatroom.jsonl` 不删,但新 agent 入场不喂入(供事后审计/复盘)
- **摘要 prompt 模板**(后端固定):
  > 这是一段 agent 协作的对话,请压缩成 ≤200 字要点摘要,**保留**: 谁做了什么决定、谁发现了什么问题、被采纳的方案。**不要保留**: 细节寒暄、被否决方案的过程、tool call 的具体参数。

#### Layer 3 — 新 agent 入场喂入策略

新 agent spawn 时,system prompt 注入分四块:

```
1. 任务背景摘要      (chatroom.summary.jsonl 全部,时间序拼接)
2. 钉选消息全文      (pinned-messages,时间序)
3. 最近 30 条普通消息(time-window 滑窗)
4. 相关 artifact 索引(类型 + 路径 + 一行摘要;不读全文)
```

想读 artifact 全文,agent 自己调 `artifact_get`。

### 11.2 不上 RAG 的理由

- **工程量大**: 需要向量库 + embedding pipeline + 检索质量调优
- **chatroom 不是问答库,是有时序的协作流**;时序对理解至关重要,RAG 的"按相关度乱序检索"反而失真
- 前两层覆盖 80%+ 场景;若 v0.3 引入跨任务知识库,RAG 留到那时考虑

### 11.3 摘要质量保护

- 每个摘要带 confidence;低 confidence 触发系统消息让 planner 复核
- 起疑时新 agent 可调 `chatroom_recent(channel, since=<摘要时间区间>)` 拉原文
- **复盘流程(planner 在 S11)绕过压缩,直接读全量 transcript** —— 复盘需要完整事实
- `human-msg` 永不参与摘要,人类原话保真

### 11.4 工厂可配置

```yaml
# factory yaml
chatroomCompression:
  enabled: true               # 是否启用压缩(planner 默认 false,其他 true)
  windowSize: 30              # 新 agent 入场喂入最近 N 条普通消息
  summaryThreshold: 100       # 多少条普通消息后开始摘要
```

planner 默认 `enabled: false`(全量读),其他工厂默认 `enabled: true`。

---

## 附 A. 决策记录

### v0.1 → v0.2

| v0.1 待决策项 | v0.2 决议 |
|---|---|
| 多任务 worktree 数据共享 | **不共享**,每个 task 独立 worktree;借 `sw` skill 复用依赖缓存方案 |
| Agent crash 处理 | **直接弃用 + 重新搞实例**,新实例通过 `chatroom_recent` + `artifact_list` 重建上下文 |
| chatroom 压缩 | **钉选 + 滚动摘要混合**(详见 §11);不上 RAG |
| anti↔eng 死循环 | **3 次**回打仍 🔴 → anti @ planner 升级人类(§3.5 + §5.3) |
| 跨任务知识库污染 | **每条建议由人类勾选才入库**(§9);默认不勾,避免单次任务噪声污染 |

### v0.2 → v0.3

| v0.2 设计 | v0.3 调整 | 理由 |
|---|---|---|
| `~/.agent-team/agents/` 顶层目录 | `<task-workdir>/agents/<id>/` 挪进 task 内 | task 是核心叙事单元,agent 是 task 资源,统一归属 |
| 工厂 lifecycle 三种 (`alwaysOn` / `spawnOnPhase` / `spawnOnDemand`) | **全部 `alwaysOn`** (S2 一次招满 + task done 才释放) | 简化模型;SIGSTOP 抑制 idle 资源占用;复盘时所有 agent 都还在 |
| 岗位 `offline` 表"丢失",`vacant` 来自释放 | `offline` 是 SIGSTOP 正常子态;`vacant` 仅 crash 短暂存在,立即重 spawn | 岗位状态机更清晰;正常路径无 vacant |
| internal-cli 作为 Claude Code skill | 改为 bash CLI 命令(新字段 `recommendedCliTools[]`);加 `docs-cli` | internal-cli/docs-cli 实际是公司内部 bash CLI,不是 skill |
| agent 只有 agent-id 命名 | 加 `displayName`,从工厂 `defaultNamePool` 抽签中国历史人物 | 拟人化展示,chatroom 阅读体验更好(诸葛亮/墨子/包拯…)|
| 范围: 为多人/远端/跨任务/分支/市场留口子 | 收敛到**单人 + 本地 + 1:1 task=chatroom** | 聚焦 MVP,降低 over-engineering 风险 |

### v0.3 → v0.4

| v0.3 设计 | v0.4 调整 | 理由 |
|---|---|---|
| `internal-cli` 作为 pm-ux 工厂默认 `recommendedCliTools` | **解耦**: 不进任何工厂默认配置;改由 task-plan 的 `seatPlan[].mcpInjections` 按上下文注入 | 用户原话"不要耦合,只有和内网相关时才走 internal-cli";外网任务不该被绑定 |
| internal-cli 走 bash CLI 路径 | 走 **MCP server**(`internal-cli mcp` stdio) | 探查发现 internal-cli 自带 MCP 模式,结构化 tool-call 比拼 bash 命令稳得多 |
| `recommendedCliTools` 字段无注释 | 明确"只放跨场景通用";`optionalMcps` 明确"工厂层不预激活" | 让字段语义清楚,避免下次又往里塞耦合工具 |
| `Task.seatPlan` 仅含角色+工厂+数量 | 拆为 `SeatSpec[]`,每条可选 `mcpInjections[]` + `rationale` | 承载 task 级注入声明 |
| docs-cli 与 skill 关系不明 | docs-cli 默认 bash + 配合 `docs-fetch/table-fetch/im-fetch/...` skill;cli 做鉴权+命令,skill 教 API 模式 | docs-cli 官方推荐就是和 Claude Code skill 配合用 |
| §3 各工厂列 internal-cli allow-domains 预设表 | **不填表**,只留"各工厂按 task 上下文自定 allow-domains" 说明 | 任务差异大,预设表反而误导;按需即可 |

### v0.4 → v0.5

| v0.4 设计 | v0.5 调整 | 理由 |
|---|---|---|
| 工厂条目里有"`ui-impl`(必)"/"必需 MCP"/"docs-cli(必)"等措辞 | **去 "必"**,统一为"推荐";架构层只保留 `coreMcps`(`chatroom-mcp` 等)是真必装 | 用户原话"所谓必填是对架构实现的要求,产品层用户自己决策即可" |
| Factory schema: `requiredMcps` + `optionalMcps` 双字段 + 注释解释语义 | 重整为 `coreMcps`(架构强制,用户不可删)+ `recommendedMcps`(工厂推荐,用户可增删) | 字段名直接表达语义,无歧义 |
| planner 在 task-plan 圈定 `internal-cli mcp --allow-domains <list>` | 不传 `--allow-domains`,**agent 自主决策**用哪个子领域 | 用户原话"agent 自主决策即可;早期 permission 不做太严格"; 减少 over-engineering |
| permissions 精细到子命令 (`Bash(internal-cli get:*)`) | **默认宽松**,整命名空间放开(`internal-cli.*` / `Bash(docs-cli:*)`);要收紧由用户在前端 permission 字段显式写 | 早期允许 agent 灵活探索,迭代后再收紧;运营数据驱动 |
| §6.8 有"内网关键词但无注入 → warning" 校验 | 删除;planner 自己判断,系统不预设规则 | 不预设规则,简化机制 |

收敛: internal-cli / docs-cli 接口契约(原 v0.4 待解项)已完成探查,纳入 §3 + §6.8。

## 附 B. 留给 v0.6+ 的开放问题(已大幅收敛)

- **能力 diff 可视化**: 复盘里 "实际安装 skill vs 工厂模板" 的 diff 卡片粒度(M4 完善)
- **internal-cli MCP 跨 vregion / site 切换**: 同一任务跨多 region 时是否每个 region 起独立 MCP 实例?(v0.4 假设单 vregion;M3 落地时再看)
- **permission 收紧时机**: v0.5 默认宽松;实战中发现哪种粒度收紧最有价值(子命令级 / 工具命名空间级 / domain 级)再加规则,运营数据驱动

> v0.4 → v0.5 收敛: 必装 vs 推荐二分清晰化;permission 早期宽松不再悬挂
> v0.3 → v0.4 收敛: internal-cli/docs-cli 接口探查已完成
> v0.3 收敛(不做): 多人协作 / 远端运行 / 跨任务 agent / chatroom 分支 / 工厂市场
