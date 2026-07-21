# artifact-management Specification

## Purpose
TBD - created by archiving change m1-skeleton. Update Purpose after archive.
## Requirements
### Requirement: 制品类型枚举

系统 SHALL 维护一个固定的 artifact 类型枚举:`proposal | acceptance | visual-contract | design | tasks | decisions | test-report | verification-report | verification-loop | anti-round-1 | anti-round-2 | ci-report | retrospective | other`。每个类型对应特定的路径模板(见下)和可选 schema 校验规则。

#### Scenario: 注册已知类型

- **WHEN** engineer 调 `artifact_register(taskId, path='eng/test-report.md', type='test-report', producer=<agentId>, summary='unit + e2e 全过')`
- **THEN** chatroom-mcp 接受,写入 SQLite `artifacts` 表,前端 files tab 实时刷新

#### Scenario: 未知类型用 other

- **WHEN** 注册了一个没在枚举中的 type
- **THEN** type 自动映射到 `other`,日志记 `WARN: unknown artifact type 'X' mapped to other`

### Requirement: 任务目录强约束

每个 task 的目录结构 MUST 遵守约束(便于复盘 agent 索引 + 全文搜索)。Task 管理目录属于 `.agent-team/<projectId>` 空间；业务代码 worktree 是 bootstrap resource，挂载到 task 管理目录下的 `worktree/` 或 resource 记录中的 path。Planner 产出的 OpenSpec change MUST 放在 task/project planning home，不得默认写入业务 worktree。

```
~/.agent-team/projects/<project>/tasks/<task-id>/
  chatroom.jsonl              # 原始消息流
  state.json                  # 状态机当前态 + 历史
  resources/                  # task bootstrap/resource metadata 快照(可选文件镜像)
  worktree/                   # bootstrap provider 创建的 git worktree(若 enabled/ready)
  openspec/                   # planner 产出的 OpenSpec planning artifacts
    changes/<change-name>/
  agents/<agent-id>/          # agent workspace (.claude/ + mcp.json + ...)
  plan/{task-plan.md, acceptance.md?, visual-contract.md?}
  eng/{design.md?, tasks.md?, decisions.md?, test-report.md}
  qa/{verification_report.md, verification_loop_1.md}
  ci/{mr-link.txt, ci_report.md, ci-issues-1.md}
  retro/{retrospective.md, archive-plan.md}
```

M1/M2 目录可按已实现工厂渐进出现，但 `openspec/`、`retro/archive-plan.md` 和 task resources 的职责边界 MUST 保持：规划与收尾落 task 管理空间，代码改动落 worktree。

#### Scenario: Task 目录包含 planning home

- **WHEN** planner 为 task 产出 OpenSpec change
- **THEN** change 文件 MUST 位于 `~/.agent-team/projects/<project>/tasks/<task-id>/openspec/changes/<name>/`
- **AND** 不得默认写入业务 worktree 的 `openspec/changes/`

#### Scenario: Worktree resource ready 后目录可用

- **WHEN** bootstrap provider 成功创建 worktree
- **THEN** `worktree/` MUST 是真实 git worktree 或 resource path 指向的真实 git checkout
- **AND** 任务目录/DB MUST 能追溯该 worktree 的 branch、baseRef、provider、mode

#### Scenario: 收尾归档后仍可读

- **WHEN** task 进入 done
- **THEN** `retro/retrospective.md`、`retro/archive-plan.md`、task resources、OpenSpec planning artifacts、chatroom 历史和 agent snapshots MUST 仍可访问

### Requirement: artifact_register 登记契约

`artifact_register(taskId, path, type, producer, summary, refs?)` MUST:校验 path 在 task 目录内且文件存在;type 在枚举内;producer 是该 task 的某 agent;返回 `{artifactId}`(用于 refs 引用)。

#### Scenario: 路径在 task 外被拒

- **WHEN** agent 调 `artifact_register(taskId, path='/etc/passwd', type='other', ...)`
- **THEN** 拒绝,reason `path must be within task workdir`

#### Scenario: 文件不存在被拒

- **WHEN** path 在 task 目录内但文件不存在(忘了先写)
- **THEN** 拒绝,reason `file not found at <path>`

### Requirement: artifact_list 与 artifact_get

`artifact_list(taskId, type?, producer?)` SHALL 返回符合条件的 artifact 列表(含 id / path / type / producer / summary / createdAt / refs);`artifact_get(artifactId)` SHALL 返回 artifact 元数据 + 文件内容(读 path 文件)。

#### Scenario: 按类型查

- **WHEN** engineer 调 `artifact_list(taskId, type='task-plan')`(其实应该是 plan 类,这里举例)
- **THEN** 返回该 task 所有 plan 类型 artifact 的元数据列表

#### Scenario: 拉文件内容

- **WHEN** engineer 调 `artifact_get(artifactId)` 拿 task-plan 全文
- **THEN** 返回元数据 + 完整 markdown 内容

### Requirement: refs 双向锚定

artifact 可以 `refs[]` 指向其他 artifact(如 `design.md` refs `task-plan.md`);chatroom 消息也可以 `refs` 指向 artifact(消息卡片显示可点击)。系统 SHALL 维护正反向索引,前端"文档 tab 点击 → 跳到登记消息 / 消息中点 ref 卡片 → 跳到文档"。

#### Scenario: 消息引用 artifact

- **WHEN** pm-ux 调 `chatroom_send(channel='main', type='handoff', content='3 份文档已落', refs=[proposalId, acceptanceId, visualContractId])`
- **THEN** 消息在 chatroom 显示 3 张可点击的 artifact 卡片,点击跳到 files tab + 预览

#### Scenario: 文档跳消息

- **WHEN** 前端在 files tab 点开 task-plan.md,选"查找登记消息"
- **THEN** 跳回 chatroom 滚动到 `artifact_register` 触发的那条 system-event

### Requirement: 制品归档不删除

task 进入 `archived` / `aborted` 后,任务目录(含所有 artifact + chatroom.jsonl + agents/<id>/ workspace)MUST 保留,不主动删除;前端的复盘视图与 files tab 仍可访问。手工清理由用户决定。

#### Scenario: 归档后仍可读

- **WHEN** task 归档 30 天后用户想看复盘
- **THEN** 前端能正常加载该 task 的 retrospective.md + 全部 artifact + chatroom 历史(SQLite 索引保留 + 文件保留)

### Requirement: Archive plan 制品

Releasing 阶段 planner SHALL 产出 `retro/archive-plan.md`，记录 OpenSpec archive 建议/执行结果、worktree resource release 建议、保留或删除原因、后续人工动作。

#### Scenario: Worktree retained 进入 archive plan

- **WHEN** worktree release 终态为 `retained` 或 `needs-review`
- **THEN** planner MUST 在 `retro/archive-plan.md` 中记录 worktree path、branch、保留原因和建议后续动作

#### Scenario: OpenSpec archive 建议

- **WHEN** task 使用 OpenSpec planning artifacts
- **THEN** planner MUST 在 `retro/archive-plan.md` 中说明 change 是否已 archive、是否 deferred、或为什么不需要 archive

