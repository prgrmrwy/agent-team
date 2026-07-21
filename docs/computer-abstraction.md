# Computer 抽象方案（为远程化准备，M1 落抽象层）

> 目标：把"agent 的 AI CLI 在哪台机器跑 + 本地 OS 能力（bash/git/io）怎么访问"抽象到一个 `Computer` 接口背后。
> 这样 orchestration 代码不变,既能在**本地同机**跑(现状),也能**远程 server + 本地执行**(很快要做)。
> **M1 只落"抽象缝"(`Computer` 接口 + `LocalComputer`,零行为变化);远程实现随后。**

## 1. 现状(要被抽象的耦合)

- `task-process`(server fork)**同机直接 spawn** AI CLI 桥接(`claude-code-acp` / codex)——经 `adapter-factory` → `CliAdapter`(acp-adapter / codex-sdk-adapter)。
- agent 的 bash/git/io = **AI CLI 自带原生工具**,跑在 **server 这台机器**上。
- worktree 创建、workspace 落盘也都在 server 本机。
- at-hook 把工具调用上报 server。

→ 隐含假设：**agent 执行 = server 同机**。远程化(server 在云、执行在用户本机)做不到。

## 2. 抽象：`Computer` = 执行基底

一台**能跑 agent 运行时 + 执行本地能力**的机器(本地或远程)。职责：

```
interface Computer {
  readonly id: string
  capabilities(): { providers: RuntimeProvider[]; tools: string[] }   // 这台机能跑哪些 provider / 有哪些工具
  // 运行时（在这台机器上起一个 AI CLI 会话）
  spawnAgentRuntime(opts: {
    provider: RuntimeProvider; model?: string
    workspace: string; additionalDirs: string[]; mcpServers: McpServer[]; initialPrompt: string
  }): Promise<SessionHandle>
  prompt(s: SessionHandle, text: string): Promise<void>
  interrupt(s): Promise<void>;  kill(s): Promise<void>
  // 事件流（复用现有 RuntimeText/Tool/Error 事件）
  on('text'|'tool'|'exit', cb)
  // 本地能力（非 agent 自驱的编排级操作：建 worktree、装 lean deps 等）
  exec(cmd: string[], cwd?: string): Promise<{ code; stdout; stderr }>
  prepareWorkspace(spec): Promise<void>   // worktree add / symlink deps，都在这台机器上做
}
```

**关键分层**：
- `Computer` = **位置/传输**(在哪台机器、怎么把指令送过去)。
- `CliAdapter`(acp / codex)= **provider 协议**(怎么跟 claude-acp / codex 对话)。adapter 不变,只是从"在 server 本机 spawn"变成"在某个 Computer 上 spawn"。

## 3. 两个实现

| 实现 | 何时 | 怎么做 |
|---|---|---|
| **LocalComputer** | M1(现状重构) | 把现有"同机 fork 桥接 + 本机 exec/worktree"包进来。**零行为变化**,只是搬到接口后面。 |
| **RemoteComputer** | 远程化(随后) | server 持有到本机 `computer` daemon 的连接;`spawnAgentRuntime`/`exec`/`prepareWorkspace` 全部 **RPC 给 daemon**,daemon 在用户本机用 LocalComputer 同款逻辑执行,事件流回传。 |

## 4. `computer` 守护进程(本地 agent,远程化时启用)

用户本机跑的小二进制：

```
computer connect <server-url> --token ...
```

- 向 server **注册能力**：本机有哪些 provider 鉴权(claude 订阅 / codex auth)、哪些工具(bash/git)。
- 经连接(复用 **ws** 基础设施)接收 spawn/prompt/control,在**本机**起 AI CLI 会话(用本机鉴权)、跑本机 OS 操作,把 text/tool/exit 事件 + at-hook 流回 server。
- 这是"远程 server + 本地执行"成立的关键件。

## 5. 与现有代码的接缝

- 今天：`createCliAdapter(provider)` → `CliAdapter` → 本机 spawn。
- 之后：`resolveComputer(seat/task) → Computer`;`Computer.spawnAgentRuntime(...)` 内部仍用对应 provider 的 `CliAdapter`,只是在"这台 Computer"上。
- **Computer 解析按 agent 级**(和 runtime provider 同款决策链)：`SeatSpec.computer` override → `Factory.preferredComputer` → env → 默认 `LocalComputer`。同一 task 内不同 agent 可落在不同 Computer。

## 6. M1 范围 vs 随后

- **M1（落抽象缝）**：
  - 定义 `Computer` 接口 + `LocalComputer`(把现有 spawn / exec / worktree / lean-deps 逻辑搬进去)。
  - `task-process` 改为通过 `Computer` 调用(不再直接 fork 桥接)。**行为不变、测试不变**。
  - 协议层加 `RuntimeProvider` 旁的占位(computer id / capability),`SeatSpec.computer` / `Factory.preferredComputer` 字段预留。
- **随后（远程化真做时）**：
  - `RemoteComputer` + `computer` daemon + 注册/鉴权/能力协商 + ws RPC 通道。
  - 安全：daemon token 鉴权、能力沙箱、路径白名单。

> 理由：抽象缝便宜(纯重构),**现在埋好,远程化时不动 orchestration**;daemon 等真要远程时再写。

## 7. 待决策 / 风险

1. **RemoteComputer 传输**：复用现有 ws(已有基建)还是 grpc？倾向 ws。
2. **能力归属**：bash/git/io 多数由 AI CLI 原生工具完成(自然跑在 Computer 上);`exec`/`prepareWorkspace` 用于**编排级**操作(建 worktree/装依赖)——这些今天在 server 本机做,远程时必须改走 Computer,**别遗漏 worktree 这条**。
3. **粒度**：Computer 按 agent 级解析(同 runtime),M1 全 `LocalComputer`。
4. **at-hook**：远程时 at-hook 在 daemon 端采集、随事件流回传。
5. **故障**：daemon 掉线 = 该 Computer 上所有 agent 视为 offline,触发 seat 重招(复用现有崩溃恢复)。
