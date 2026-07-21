# task-bootstrap Specification

## Purpose
TBD - created by archiving change task-bootstrap-lifecycle. Update Purpose after archive.
## Requirements
### Requirement: Task bootstrap provider

系统 SHALL 支持 task 启动时由 orchestrator 调用 bootstrap provider 来准备任务工作区。Bootstrap provider MUST 是机器可调用程序入口，而不是只能被 agent 阅读的 Markdown skill。Provider 至少 MUST 支持 `prepare`、`status`、`release` 三类动作，并以结构化 JSON 返回结果。

#### Scenario: 创建任务时运行 bootstrap

- **WHEN** 用户创建 task 且项目默认 bootstrap provider 为 `sw` 或 `generic-pnpm`
- **THEN** orchestrator MUST 在 task 初始化后启动 bootstrap `prepare`
- **AND** bootstrap MUST 与 planner 初始化并行运行
- **AND** bootstrap 结果 MUST 写入 task resource 记录

#### Scenario: Provider 返回结构化失败

- **WHEN** bootstrap provider 创建 worktree 或初始化依赖失败
- **THEN** provider MUST 返回 `status = failed`、错误原因和可重试标记
- **AND** orchestrator MUST 记录失败 resource，不得把空目录标记为 ready worktree

### Requirement: Bootstrap resource 持久化

系统 SHALL 将 bootstrap 产生的副作用记录为 task resource。Worktree resource MUST 至少包含 kind、status、provider、mode、path、branch、baseRef、summary、error、createdAt、updatedAt。Task resource 是 planner、engineer、qa、ci、前端和 release 流程共享的权威数据源。

#### Scenario: Worktree ready

- **WHEN** bootstrap 成功创建隔离 git worktree 并完成 lean/full 初始化
- **THEN** task resource MUST 记录 `kind = worktree`、`status = ready`、绝对 `path`、`branch`、`mode`
- **AND** chatroom MUST 写入 system-event 说明 bootstrap ready

#### Scenario: Retry failed bootstrap

- **WHEN** worktree resource 处于 `failed`
- **THEN** 用户或 orchestrator MUST 可以触发 retry
- **AND** retry MUST 更新同一 resource 的 attempt/status/error，而不是制造多个互相冲突的 primary worktree

### Requirement: Bootstrap 默认配置本地持久化

系统 SHALL 支持项目或仓库级默认 bootstrap 配置，并在创建 task 时自动应用。默认配置 MUST 支持 provider/profile、mode、enabled/none 等字段。用户不需要在每次 task 创建时勾选 worktree。

#### Scenario: 使用持久化默认配置

- **WHEN** 项目默认 bootstrap 配置为 `{ provider: "sw", mode: "lean" }`
- **THEN** 新 task 创建时 MUST 自动使用该配置启动 bootstrap
- **AND** 前端 MUST 显示实际 provider/mode 的初始化状态

#### Scenario: 禁用 bootstrap

- **WHEN** 项目默认 bootstrap 配置为 `none` 或 disabled
- **THEN** 新 task MUST 不创建 worktree resource
- **AND** planner 仍 MUST 能启动并进行需求对齐

### Requirement: Bootstrap progress 可见

系统 SHALL 在前端和 chatroom 中展示 planner 初始化与 bootstrap 初始化的独立进度。Bootstrap progress MUST 至少区分 creating、ready、failed。

#### Scenario: 并行初始化展示

- **WHEN** task 刚创建且 planner 与 bootstrap 都在初始化
- **THEN** 前端 MUST 显示类似 `planner initializing...` 与 `bootstrap sw/lean... creating...` 的轻量状态
- **AND** 任一项完成后 MUST 显示完成标记

#### Scenario: Bootstrap 失败展示 retry

- **WHEN** bootstrap resource 进入 `failed`
- **THEN** 前端 MUST 显示失败原因摘要和 retry 入口
- **AND** task MUST 不被标记为 done 或 process-crashed

### Requirement: Task resource release

系统 SHALL 在 task 收尾时对 bootstrap resources 执行 release。Release MUST 支持 retained、removed、archived、needs-review 等终态；worktree release 不等于强制删除。默认策略 MUST 保守，不确定安全时保留 resource 并记录原因。

#### Scenario: Worktree 保守保留

- **WHEN** task 进入 releasing 且 worktree 无法证明已合入或可安全删除
- **THEN** release provider MUST 将 worktree resource 标记为 `retained` 或 `needs-review`
- **AND** task MUST 在 archive-plan 中记录保留原因与路径

#### Scenario: Worktree 可安全删除

- **WHEN** release provider 能证明 worktree clean 且 branch 已合入或满足 remove-if-clean 策略
- **THEN** orchestrator MAY 调用 provider 删除 worktree
- **AND** resource MUST 记录终态 `removed`、执行时间和摘要

