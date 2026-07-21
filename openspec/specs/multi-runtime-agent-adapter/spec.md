# multi-runtime-agent-adapter Specification

## Purpose
TBD - created by archiving change add-codex-runtime-adapter. Update Purpose after archive.
## Requirements
### Requirement: Model profile selection

task-process SHALL 按 spawned agent 粒度选择 model profile，确定性顺序为：seat `modelOverride` → factory `preferredModelProfile` → 当更早 provider 本机不可用或因 provider availability 原因失败时，按顺序尝试 factory `fallbackModelProfiles[]` → task/process environment fallback → 默认 provider adapter `claude-acp`。本 change 支持的 provider adapter 标识 MUST 包含 `claude-acp`、`codex-sdk` 和 `codex-exec`。

被选中的 model profile snapshot MUST 存入 spawned agent record。若选中的是 fallback model profile，snapshot MUST 反映实际使用的 provider/model，而不是被跳过的 primary model profile。

#### Scenario: 默认 provider adapter 仍为 Claude ACP
- **WHEN** 没有 seat model override、没有 factory `preferredModelProfile`、没有 factory fallback model profile、也没有 environment fallback
- **THEN** task-process MUST 使用既有 Claude ACP provider adapter 来 spawn 新 agent

#### Scenario: Factory 为单个角色选择 Codex SDK
- **WHEN** engineer factory 有 `preferredModelProfile.provider = codex-sdk`，且 planner factory 没有 preferred model profile
- **THEN** 新 spawn 的 engineer agents MUST 使用 Codex SDK，而 planner agents 继续使用默认 provider

#### Scenario: Factory fallback 选择可用 provider
- **WHEN** planner factory 的 primary 为 `preferredModelProfile.provider = claude-acp`
- **AND** planner factory 的第一个 fallback 为 `fallbackModelProfiles[0].provider = codex-sdk`
- **AND** 本机 provider discovery 报告 `claude-acp` 不可用且 `codex-sdk` 可用
- **THEN** 新 spawn 的 planner agents MUST 使用 `codex-sdk` fallback model profile
- **AND** agent model profile snapshot MUST 记录 `provider = codex-sdk`

#### Scenario: Seat model override 跳过 factory fallback
- **WHEN** 某个 seat 有 `modelOverride.provider = codex-sdk`
- **AND** 它的 factory 有 primary `claude-acp` 和 fallback `codex-sdk`
- **THEN** spawned agent MUST 使用 seat model override
- **AND** 该 seat MUST NOT 执行 factory primary/fallback selection

#### Scenario: 环境变量 fallback 选择 Codex SDK
- **WHEN** 没有 seat 或 factory model profile 配置，且 task-process 启动时设置 `AGENT_TEAM_ADAPTER=codex-sdk`
- **THEN** 新 spawn 的 agents MUST 使用 Codex SDK provider adapter 作为 fallback

#### Scenario: 未知 provider 被拒绝
- **WHEN** `AGENT_TEAM_ADAPTER` 设置为不支持的值
- **THEN** task-process MUST 拒绝 agent spawn，并给出包含 unsupported provider 名称的清晰 notification

### Requirement: Provider model selection
Model profile configuration SHALL support provider-native model selection at agent scope. At minimum, Codex SDK model profile configuration MUST accept `model` and `reasoningEffort` and pass them to the Codex thread when supported by the SDK.

#### Scenario: Codex model is passed to thread
- **WHEN** an agent is spawned with `preferredModelProfile = { provider: "codex-sdk", model: "gpt-5.5", reasoningEffort: "high" }`
- **THEN** the Codex SDK adapter MUST start that agent's thread with the requested model and reasoning effort

#### Scenario: Provider does not support a field
- **WHEN** a model profile contains a field that the chosen provider adapter cannot honor
- **THEN** the adapter MAY ignore that field, but the resolved model profile snapshot MUST remain visible on the agent/factory snapshot for audit and retro

### Requirement: Provider-neutral adapter events
The runtime adapter layer SHALL expose provider-neutral events to task-process code. Task-process code MUST NOT depend on ACP-specific event shapes when recording chatroom text, tool traces, turn completion, token usage, provider errors, or provider exits. Provider-neutral turn completion events MUST preserve provider token usage when the provider exposes it. Token usage MAY be absent for providers that do not expose usage on done events, but adapters MUST NOT discard usage that is available in provider events.

#### Scenario: Claude update is normalized
- **WHEN** Claude ACP emits an assistant text update
- **THEN** the adapter layer MUST emit a normalized text event that task-process can write to chatroom without parsing ACP fields

#### Scenario: Codex update is normalized
- **WHEN** Codex emits a JSONL or SDK event for an assistant message, command execution, MCP tool call, or turn completion
- **THEN** the adapter layer MUST emit the corresponding normalized text, tool, or done event

#### Scenario: Codex usage is preserved
- **WHEN** Codex emits a turn completion event containing input, cached input, output, reasoning, or total token usage
- **THEN** the adapter layer MUST include that usage payload in the normalized done event
- **AND** task-process MUST be able to persist it without parsing Codex-specific event shapes

#### Scenario: Provider done without usage remains valid
- **WHEN** a provider emits a done event without token usage
- **THEN** the adapter layer MUST still emit the normalized done event
- **AND** runtime usage collection MAY rely on provider-specific telemetry or fallback importers outside the done event

### Requirement: Codex local preflight
The system SHALL provide a fast Codex preflight that verifies the local Codex runtime is installed, authenticated, and able to execute a minimal non-interactive turn before a full task E2E uses Codex.

#### Scenario: Codex preflight succeeds
- **WHEN** `codex --version`, `codex doctor`, and a tiny `codex exec --json` smoke run all succeed
- **THEN** the preflight MUST report Codex as available for task runtime experiments

#### Scenario: Codex preflight fails
- **WHEN** Codex is missing, unauthenticated, or unable to complete a tiny non-interactive turn
- **THEN** the preflight MUST fail with a concise reason and MUST NOT start a full Codex-backed task E2E

### Requirement: Codex SDK adapter
The Codex SDK adapter SHALL maintain one Codex thread per spawned agent session and SHALL continue that same thread for later prompts to preserve agent context across turns.

#### Scenario: Spawn creates a Codex session
- **WHEN** an agent is spawned with provider `codex-sdk`
- **THEN** the adapter MUST create a Codex thread rooted at the agent workspace, run the initial prompt, and return a stable session id mapped to that thread

#### Scenario: Prompt continues the same Codex session
- **WHEN** task-process sends a later human or system prompt to the same Codex-backed agent
- **THEN** the adapter MUST run that prompt on the existing Codex thread rather than starting an unrelated new conversation

### Requirement: Codex exec smoke fallback
The Codex exec adapter SHALL support one-shot non-interactive JSONL execution for smoke testing and fallback diagnostics, even if it is not the preferred alwaysOn runtime.

#### Scenario: Exec JSONL events are parsed
- **WHEN** `codex exec --json` emits thread, item, turn, or error events
- **THEN** the adapter MUST parse JSONL incrementally and emit normalized adapter events

#### Scenario: Exec fallback reports non-resumable behavior
- **WHEN** `codex-exec` is selected for a multi-turn agent session
- **THEN** the adapter MUST either resume a previous exec session explicitly or report that the provider is one-shot and unsuitable for alwaysOn multi-turn use

### Requirement: Runtime errors do not crash task-process
Runtime provider errors SHALL be converted into structured adapter error events and task notifications. A provider quota, authentication, missing-binary, or runtime failure MUST NOT propagate as an uncaughtException that shuts down the task-process.

#### Scenario: Provider quota error is reported
- **WHEN** a provider returns a quota or usage-limit error during prompt execution
- **THEN** task-process MUST emit an error notification to the parent server and keep task state inspectable

#### Scenario: Missing Codex binary is reported
- **WHEN** `codex-sdk` or `codex-exec` is selected but the Codex binary is unavailable
- **THEN** agent spawn MUST fail with a clear notification and MUST NOT leave the seat incorrectly marked idle

### Requirement: 本机 provider discovery

server SHALL 暴露只读的本机 provider discovery 能力，用于报告本机可检测 model provider。Discovery 结果 MUST 包含 provider id、availability boolean、可选 model list，以及检测失败时的 unavailable reason。本 change 的 discovery SHALL 仅限本机：server、worktree 文件系统、CLI binary 和 agent workspace 都假设在同一台机器上。

#### Scenario: 本机 provider list 报告可用 provider

- **WHEN** 本机存在可检测的 `claude-acp` provider adapter
- **THEN** 本机 provider list MUST 包含 provider `claude-acp` 且 `available = true`
- **AND** 当 provider 能低成本列出模型时，结果 MAY 包含 provider-native model names

#### Scenario: 本机 provider list 报告不可用 provider

- **WHEN** 本机不存在可检测的 `codex-sdk` provider adapter，或其 CLI/auth smoke check 失败
- **THEN** 本机 provider list MUST 包含 provider `codex-sdk` 且 `available = false`
- **AND** 结果 MUST 包含适合在 factory 或 agent profile UI 展示的简短 reason

#### Scenario: 远端 provider discovery 延期

- **WHEN** 某个 provider 只在另一台机器上可用
- **THEN** 本 change MUST NOT 尝试发现、选择或 spawn 到该远端 provider
- **AND** 本机 provider list MUST 保持仅面向 server 所在机器

### Requirement: Model profile fallback failure reporting

当没有任何候选 model profile 可用于 spawn 时，task-process SHALL 上报结构化 notification，并保持受影响 seat 可检查。它 MUST NOT 在没有 agent 的情况下把 seat 留成 idle。

#### Scenario: 所有 factory model profiles 都不可用

- **WHEN** 某个 factory primary model profile 和所有 fallback model profiles 在本机都不可用
- **THEN** agent spawn MUST 失败，并给出列明已尝试 providers 的清晰 notification
- **AND** 受影响 seat MUST 保持或回到 `vacant`

#### Scenario: 创建探针失败后 fallback 成功

- **WHEN** primary model profile 通过 discovery 且 session 能创建
- **AND** 创建时轻量 prompt 探针因 auth、quota、usage-limit 或 provider availability error 失败
- **AND** 后续 fallback model profile 可用
- **THEN** task-process MUST 销毁探针失败的临时 session
- **AND** task-process MUST 尝试该 fallback model profile
- **AND** 最终 agent snapshot MUST 记录实际 spawn 成功的 fallback model profile

### Requirement: 运行中 quota fallback

运行中的 agent 如果收到 provider quota 或 usage-limit 类错误，task-process SHALL 尝试按 factory fallback model profile 创建 replacement agent。切换期间 seat status MUST 为 `switching`，前端 MUST 能展示该状态。旧 agent MUST 被终止并标记 `terminated`，replacement agent MUST 写入新的 model profile snapshot，并在 main chatroom 频道说明已切换模型并接管工作。

#### Scenario: 工作中 agent 达到 provider limit

- **WHEN** 工作中的 planner / engineer / qa / ci agent 在 prompt 执行期间收到 quota 或 usage-limit error
- **AND** 该 factory 还有另一个本机可用 fallback model profile
- **THEN** task-process MUST 将 seat 状态更新为 `switching`
- **AND** task-process MUST 在 main chatroom 写入系统消息说明当前 model profile 达到限制并正在切换
- **AND** task-process MUST kill 旧 agent session、标记旧 agent `terminated`
- **AND** task-process MUST spawn replacement agent，跳过触发 limit 的 model profile
- **AND** replacement agent MUST 先同步 chatroom/artifacts 后继续当前阶段工作

#### Scenario: 没有可用 fallback

- **WHEN** 工作中的 agent 达到 provider limit
- **AND** factory 没有其他本机可用 fallback model profile
- **THEN** task-process MUST 上报 error notification
- **AND** task-process MUST NOT 把 seat 静默标记为 idle

