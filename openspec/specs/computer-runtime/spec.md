# computer-runtime Specification

## Purpose
TBD - created by archiving change add-computer-abstraction. Update Purpose after archive.
## Requirements
### Requirement: Computer 抽象执行基底
系统 SHALL 提供一个 `Computer` 抽象,表示"能运行 agent 运行时 + 执行本地能力的一台机器"。`Computer` MUST 暴露 `createCliAdapter(provider)`(在该机器上创建对应 provider 的 `CliAdapter`)与 `exec(argv, opts?)`(在该机器上执行命令并返回 `{ code, stdout, stderr }`)。orchestration 代码 MUST 经 `Computer` 间接获取运行时,而非直接调用 `createCliAdapter`。

#### Scenario: 经 Computer 创建运行时 adapter
- **WHEN** 调用 `computer.createCliAdapter('claude-acp')`
- **THEN** 返回一个 `provider === 'claude-acp'` 的 `CliAdapter` 实例
- **AND** 该 adapter 的 spawn/prompt/kill 行为与直接 `createCliAdapter('claude-acp')` 等价

#### Scenario: 经 Computer 执行本地命令
- **WHEN** 调用 `computer.exec(['git', 'rev-parse', 'HEAD'], { cwd })`
- **THEN** 在该 Computer 上执行该命令
- **AND** 返回包含 `code`、`stdout`、`stderr` 的结果

### Requirement: Computer 按 agent 级解析
系统 SHALL 按 agent(seat)级解析使用哪个 `Computer`,解析顺序 MUST 为:`SeatSpec.computer` → `Factory.preferredComputer` → 环境变量 `AGENT_TEAM_COMPUTER` → 默认 `'local'`。同一个 task 内不同 agent MAY 落在不同 `Computer`。

#### Scenario: 默认解析为 local
- **WHEN** seat 未指定 `computer`、其 factory 未设 `preferredComputer`、且环境变量 `AGENT_TEAM_COMPUTER` 未设置
- **THEN** 解析结果 MUST 为 `LocalComputer`(id = `'local'`)

#### Scenario: seat override 优先级最高
- **WHEN** seat 的 `computer` 字段已指定一个 computer id
- **THEN** 解析 MUST 采用该 id,忽略 factory preferred 与环境变量

### Requirement: LocalComputer 同机执行且零行为变化
系统 SHALL 提供 `LocalComputer` 实现,在 server 同机执行。`LocalComputer.createCliAdapter` MUST 等价于现有的本机 `createCliAdapter`,`LocalComputer.exec` MUST 在本机执行命令。引入 `Computer` 抽象后,既有 agent 生成与运行流程的可观察行为 MUST NOT 改变(现有测试与 preflight 全通过)。

#### Scenario: LocalComputer 运行时等价现状
- **WHEN** 在 `LocalComputer` 上为某 agent spawn 运行时
- **THEN** agent 的 spawn / chatroom / propose / 状态推进行为与抽象引入前一致
- **AND** `pnpm preflight` 与既有单元测试全部通过

