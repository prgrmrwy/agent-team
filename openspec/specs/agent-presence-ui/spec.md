# agent-presence-ui Specification

## Purpose
TBD - created by archiving change unify-agent-avatar-and-seats-bar. Update Purpose after archive.
## Requirements
### Requirement: agent / seat 在 UI 中的状态分类

前端 SHALL 把 agent 与 seat 的运行态投影到一个有限的展示状态集 `AvatarStatus`,包含至少:`working`、`idle`、`init`、`offline`、`vacant`、`terminated`。该集合 MUST 与后端 `SeatStatus`(`init/idle/working/switching/offline/vacant`)和 `AgentRunState`(`init/idle/working/offline/terminated`)有明确的、单点定义的映射函数(下文称 `computeAvatarStatus`)。UI 渲染层 MUST NOT 各自重新解释 status,所有 avatar 角标 / 文案 / 颜色 MUST 通过同一 helper 计算。

`computeAvatarStatus(seat?, agent?)` 的优先级 SHALL 为:
1. `agent.state === 'terminated'` → `terminated`
2. seat 缺失或 `seat.currentAgentId` 为空 → `vacant`
3. `seat.status === 'working'` 或 `'switching'` 或 `agent.state === 'working'` → `working`
4. `seat.status === 'offline'` 或 `agent.state === 'offline'` → `offline`
5. `seat.status === 'init'` 或 `agent.state === 'init'` → `init`
6. `seat.status === 'vacant'` → `vacant`
7. 兜底 → `idle`

#### Scenario: vacant 与 init 视觉区分

- **WHEN** seat 已注册但 `currentAgentId` 为空,且 task 处于招募阶段
- **THEN** UI MUST 通过 `computeAvatarStatus` 得出 `vacant`,显示为"空位"或"未招募"灰色文案
- **AND** UI MUST NOT 显示"待命"或其他暗示 agent 正在 standby 的红字
- **AND** seat 正在 spawn 中(`seat.status === 'init'`)的视觉 MUST 与 vacant 区分(文案"初始化中",颜色可同灰系但语义文案不同)

#### Scenario: terminated 与 offline 视觉区分

- **WHEN** task 完成 release 后 sweep 将 agent 标记为 `terminated`
- **THEN** UI MUST 显示为灰色 badge + "归档" 文案
- **AND** UI MUST NOT 与 `offline`(连接异常,malice 红色)使用相同颜色,以避免归档任务被误判为出错

#### Scenario: 状态映射单点

- **WHEN** 在前端任何位置(消息行头像、SeatsBar、AgentPanel、MentionChip popup 等)需要计算 agent / seat 的 `AvatarStatus`
- **THEN** 实现 MUST 调用 shared 的 `computeAvatarStatus` helper
- **AND** MUST NOT 内联重复 status 判断的 if/switch 链(以防分散逻辑漂移)

### Requirement: agent 信息浮层的语义边界

前端 SHALL 提供统一的 `AgentAvatar` 组件,封装头像内核 + 状态 badge + 可选 hover 名片 + 可选 click 行为(打开 right panel agent profile)。`AgentAvatar` MUST 接受 `disableHoverCard` prop 用于嵌套场景(如已展开的 profile 顶部头像、其它已是 popup 的容器内嵌头像),被关闭时 MUST NOT 弹出任何 hover 浮层。

#### Scenario: profile 内嵌头像无 hover popup

- **WHEN** 用户点击 chatroom 消息中的 agent 头像打开 right panel agent profile
- **THEN** profile 顶部展示的大头像 MUST NOT 在 hover 时再弹出 agent 名片
- **AND** profile 内部所有 agent avatar(若有 mention / agent 引用)MUST 使用 `disableHoverCard` 以避免嵌套 popup

#### Scenario: SeatsBar 双层 hover

- **WHEN** 用户 hover SeatsBar 中某 role chip 的"色点"
- **THEN** 出现状态文案小气泡(如"工作中" / "归档" / "未招募")
- **WHEN** 用户在同一 chip 内 hover 至"席位名"文字
- **THEN** 浮层内容 MUST 切换为该 role 全部 seat 对应在岗 agent 的 avatar 列表(每个 avatar `disableHoverCard`,点击打开 right panel profile)
- **AND** 同 role 多 seat 时 chip 主体 MUST 显示数量计数(如 `engineer ×2`),避免丢信息

### Requirement: SeatsBar 不绑定具体 agent 名字

SeatsBar 每个 role chip 的主体 MUST 显示**席位名(role 文字)**而不是 `agent.displayName`。这避免:1) 同 role 多 seat 时只显示第一个 agent;2) agent 在 task 生命周期内更换(crash / fallback)时 chip 文字反复变化干扰用户认知;3) 把"席位"和"具体 agent 实例"两个不同语义层混淆。

具体 agent 信息 MUST 通过 chip 的 hover 浮层访问(详见上一 Requirement)。

#### Scenario: 同 role 多 seat

- **WHEN** planner 创建了 `Engineer #1` 和 `Engineer #2` 两个 engineer seat
- **THEN** SeatsBar engineer chip 主文字 MUST 显示 `engineer ×2`(或类似计数标识)
- **AND** 该 chip 在 hover 名字时浮层 MUST 列出两个 seat 各自在岗的 `AgentAvatar`

