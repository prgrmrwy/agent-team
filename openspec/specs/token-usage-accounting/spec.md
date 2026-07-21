# token-usage-accounting Specification

## Purpose
TBD - created by archiving change add-token-usage-accounting. Update Purpose after archive.
## Requirements
### Requirement: 统一 token usage 事件模型
系统 SHALL 为每个 task 持久化 append-only token usage 事件，用于记录 provider runtime token、provider fallback transcript token、chatroom corpus token 和 chatroom read token。事件 MUST 至少包含 taskId、可选 projectId、可选 agentId、可选 seatId、可选 factory、provider/source、可选 model/sessionId/externalRequestId、token 分项(input/cache creation/cache read/output/reasoning/total)、createdAt 和 rawUsage。系统 MUST NOT 记录 cost、价格或金额估算。

#### Scenario: 写入 runtime usage 事件
- **WHEN** 某个 agent 完成一次 provider request 并产生 token usage
- **THEN** 系统 MUST 写入一条 source=`runtime` 的 token usage 事件
- **AND** 事件 MUST 关联该 agent 的 taskId、agentId、seatId、factory、provider 和 model profile 快照
- **AND** 事件 MUST NOT 包含 cost 字段

#### Scenario: 旧 task 没有 usage 表
- **WHEN** 用户查询一个旧 task 的 usage 但该 task DB 尚无 token usage 表
- **THEN** 系统 MUST 返回空聚合结果而不是报错

### Requirement: Codex runtime token 采集
Codex SDK / Codex exec provider 产生 usage 时，系统 SHALL 从 provider-neutral done/token_count 事件中提取 input、cached input、output、reasoning 和 total tokens 并落库。对于包含累计量和单次量的 Codex token_count 事件，系统 MUST 使用单次量作为事件增量，避免重复累计。

#### Scenario: Codex SDK done usage 落库
- **WHEN** Codex SDK adapter 发出带 usage 的 turn done 事件
- **THEN** task-process MUST 按 sessionId 反查 agent 并写入 runtime token usage 事件
- **AND** cached input 与 reasoning output token MUST 分别保留为独立字段

#### Scenario: Codex token_count fallback 使用 last usage
- **WHEN** Codex fallback importer 读取到 token_count 事件且同时存在 total_token_usage 与 last_token_usage
- **THEN** importer MUST 使用 last_token_usage 写入单次 token usage 事件
- **AND** importer MUST NOT 把 total_token_usage 当作新增增量反复累加

### Requirement: Claude OpenTelemetry token 采集
Claude runtime 的实时 token 统计 SHALL 以 Claude Code OpenTelemetry 为主路径。spawn Claude agent 时，系统 MUST 注入本机 telemetry endpoint 和 resource attributes，使 telemetry payload 能归因到 projectId、taskId、agentId、seatId、factory 与 provider。系统 MUST 从 Claude token usage / api request telemetry 中提取 token 分项并落库。

#### Scenario: Claude telemetry 归因到 agent
- **WHEN** Claude Code 为某个 agent 发出 api request/token usage telemetry
- **THEN** ingest MUST 从 resource attributes 或 payload 中解析 taskId、agentId、seatId、factory、provider 和 model
- **AND** ingest MUST 写入 source=`runtime` 的 token usage 事件

#### Scenario: Telemetry endpoint 不可用
- **WHEN** Claude agent spawn 时 telemetry endpoint 配置失败或 ingest 临时不可用
- **THEN** 系统 MUST NOT 阻塞 agent spawn
- **AND** 系统 MUST 记录 warning，并允许后续 transcript fallback 补账

### Requirement: Claude transcript fallback 去重导入
系统 SHALL 提供 Claude transcript fallback importer，用于读取 `~/.claude/projects/**/*.jsonl` 中的 usage 记录并补充历史 token 统计。Importer MUST 只抽取元数据和 usage 字段，不读取或持久化消息正文。Importer MUST 按 requestId 去重；同一 requestId 出现在多条 assistant/tool_use 记录中时只能计入一次。

#### Scenario: 重复 requestId 只导入一次
- **WHEN** Claude transcript 中三行记录具有相同 requestId 且相同 message usage
- **THEN** importer MUST 只写入一条 source=`fallback-transcript` 的 token usage 事件

#### Scenario: 从 cwd 解析 agent-team 归因
- **WHEN** transcript 行的 cwd 匹配 `.agent-team/projects/<projectId>/tasks/<taskId>/agents/<agentId>`
- **THEN** importer MUST 将该 usage 归因到对应 projectId、taskId 和 agentId

#### Scenario: 无法归因的 transcript 行
- **WHEN** transcript 行包含 usage 但 cwd 无法解析到 agent-team task/agent
- **THEN** importer MUST 跳过该行或仅记录诊断日志
- **AND** importer MUST NOT 将其混入项目总量

### Requirement: Chatroom context token 统计
系统 SHALL 单独统计 chatroom context token，不得与 provider runtime token 混加。Chatroom context token 至少包含 corpus 与 read 两种 source：corpus 表示 chatroom 消息内容体量估算，read 表示 agent 通过 chatroom 工具读取到的 payload token 估算。

#### Scenario: chatroom corpus total
- **WHEN** 用户打开 chatroom profile
- **THEN** 系统 MUST 能返回该 task chatroom 按 channel 汇总的 corpus token total

#### Scenario: chatroom read attribution
- **WHEN** agent 调用 chatroom_recent 或 chatroom_listen 并收到消息 payload
- **THEN** 系统 MUST 估算返回 payload 的 token 数并写入 source=`chatroom-read` 事件
- **AND** 该事件 MUST 归因到调用 agent

### Requirement: Usage 聚合 API
系统 SHALL 提供只读 usage 聚合能力，支持 project、task/chatroom、factory 和 agent 维度查询。聚合响应 MUST 明确区分 runtime、chatroomCorpus 和 chatroomRead token，不得返回一个未标注混合含义的总数。

#### Scenario: 查询 project total
- **WHEN** 前端查询某 project 的 token usage
- **THEN** API MUST 汇总该 project 下所有 task 的 runtime token total
- **AND** 响应 MAY 包含按 task 或 factory 聚合的下一级数据

#### Scenario: 查询 factory usage
- **WHEN** 前端查询某 factory 的 profile usage
- **THEN** API MUST 返回该 factory 的 runtime token total
- **AND** API MUST 返回 token 消耗从高到低排序的前 10 个 task

#### Scenario: 查询 agent usage
- **WHEN** 前端查询某 agent 的 profile usage
- **THEN** API MUST 返回该 agent 的 runtime token total
- **AND** API MUST NOT 要求返回额外下一级排行

### Requirement: Profile usage 展示
前端 SHALL 在 chatroom、factory 和 agent profile 中展示 token usage。展示单位 MUST 使用千进制缩写 `K` / `M` / `B`，不得使用中文万/亿。排行列表 MUST 按 token 消耗从高到低排序，并且每行 MUST 显示对应消耗量。

#### Scenario: chatroom profile 展示 agent 排名
- **WHEN** 用户打开 chatroom profile
- **THEN** 前端 MUST 展示 chatroom usage total
- **AND** 前端 MUST 展示按 token 消耗从高到低排序的 agent 列表
- **AND** 每个 agent 行 MUST 显示 token 消耗量

#### Scenario: factory profile 展示前十 task
- **WHEN** 用户打开 factory profile
- **THEN** 前端 MUST 展示 factory usage total
- **AND** 前端 MUST 展示按 token 消耗从高到低排序的前 10 个 task
- **AND** 每个 task 行 MUST 显示 token 消耗量

#### Scenario: agent profile 只展示 total
- **WHEN** 用户打开 agent profile
- **THEN** 前端 MUST 展示该 agent token usage total
- **AND** 前端 MUST NOT 要求展示下一级排行

#### Scenario: K/M/B 格式化
- **WHEN** token total 为 1234567
- **THEN** 前端 MUST 以千进制缩写形式展示为约 `1.2M`

### Requirement: 系统级 token usage 聚合

系统 SHALL 提供 `GET /usage` 接口,返回跨所有 project/task 的全局 runtime token 聚合结果,用于 settings 面板的"系统总览"展示。响应 MUST 包含三部分:

1. `runtime`:跨全部 task 的 token totals(input / cache creation / cache read / output / reasoning / total)
2. `factories`:按 factory id 聚合后的 ranking,按 `totalTokens` 降序,**top 10**,**totalTokens=0 的 factory 排除**
3. `tasks`:按 task 聚合的 ranking,按 `totalTokens` 降序,**top 10**,**totalTokens=0 的 task 排除**,`label` MUST 使用 `task.title`(回退到 `taskId`)

接口 MUST NOT 返回 cost / 价格估算。接口 MUST NOT 接受时间窗参数(一期 all-time;若未来加 `?since=` 应通过新的 ADDED requirement 引入)。

#### Scenario: 空系统返回零聚合

- **WHEN** indexDb 中无 task,或所有 task DB 都没有 token usage 表
- **THEN** `GET /usage` MUST 返回 `runtime` 全 0、`tasks=[]`、`factories=[]`,而不是 500

#### Scenario: factory 跨 task 合并

- **WHEN** 多个 task 都有 factory=`engineer` 的 token usage 事件
- **THEN** `factories` ranking 中 `engineer` MUST 出现且 token 字段为各 task 的求和
- **AND** 单个 task 维度的细节 MUST NOT 暴露在此响应中(需要的话走 `/projects/:id/usage` 或 `/factories/:name/usage`)

#### Scenario: top 10 截断

- **WHEN** 系统中有超过 10 个非空 task / factory
- **THEN** `tasks` / `factories` MUST 各最多返回 10 条,按 `totalTokens` 降序
- **AND** 截断 MUST 在 server 端完成,客户端 MUST NOT 假设全集可达

#### Scenario: task label 回退

- **WHEN** 某个 task 的 `title` 字段为空或 null
- **THEN** ranking item 的 `label` MUST 等于 `taskId`(允许客户端展示一个稳定字符串)

#### Scenario: 老 task 没有 usage 表

- **WHEN** 某个 task DB 是早于 token-usage 改造的版本,缺少 `token_usage_events` 表
- **THEN** 该 task MUST 静默跳过(不进入 totals / ranking 也不报错)
- **AND** 其它 task 的聚合 MUST 不受影响

