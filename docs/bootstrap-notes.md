# Bootstrap 过程反馈（seed 阶段手动复盘）

> 背景见 [architecture.md](architecture.md) 的"自举"讨论。本文件是**第一波次浅反馈**：
> 在用 Claude Code（seed orchestrator）手搓 M1 地基时遇到的过程摩擦。
> 每条摩擦 = 一份将来 agent-team 该自动消化的信号。**「启示」列才是产出**——
> 它映射到某条 spec / 工厂 deliverable / propose 校验，是日后工厂调优的素材。

## 记录格式

| # | 阶段 | 现象 | 类别 | 对 agent-team 的启示 |
|---|---|---|---|---|

类别枚举：`toolchain`（环境/依赖）/ `contract`（契约/schema）/ `orchestration`（编排/派发）/ `verification`（验收/校验）/ `context`（上下文共享）

---

## 已记录

| # | 阶段 | 现象 | 类别 | 对 agent-team 的启示 |
|---|---|---|---|---|
| 1 | 写 specs | `openspec validate` 抓到 6 条 requirement 缺 SHALL/MUST，**含我刚手写的几条** | verification | propose 的 Layer 2（markdown AST schema 检查）应内置「spec 格式 lint」——requirement 必须含 SHALL/MUST、必须有 ≥1 个 Scenario。agent 写 spec 类 artifact 时要有格式 guard，不能等人类 review 才发现 |
| 2 | 起 Phase 0 | 机器无 pnpm，需 `corepack enable` 才能开工 | toolchain | spawn 流程 / preflight 应有「环境前置检查」：开工前验证 node≥24 + pnpm 可用 + `claude` CLI 在位，缺啥先报，而不是 agent 跑到一半才炸。映射到 proposal「外部前置条件」 |
| 3 | 编辑文档 | Edit 工具按字符精确匹配 `old_string`，多次因「与/+」等细微差异失配 | orchestration | `task_write` 的写语义要稳健（整段覆盖 / 结构化 patch），不要让 agent 依赖脆弱的字符串精确匹配做改写；artifact 编辑应基于「读-改-写全文」而非 diff 片段 |
| 4 | ACP spike | 设计 D7 把架构押在 `claude-agent-acp` 上，**npm 根本不存在此包**；真实包是 `@zed-industries/claude-code-acp`（Zed 维护），ACP SDK 是 `@agentclientprotocol/sdk` 不是 `@zed-industries/agent-client-protocol` | contract | 设计阶段引用的外部依赖（包名/CLI/接口）必须有「存在性 + 形态」核验门，不能凭检索印象写进 spec。agent-team 的 planner 在 task-plan 声明 mcpInjections / 三方依赖时，应有一步自动 `npm view` / `which` 验证，否则错误契约会扩散到所有 engineer。**这是 spike-first 的最强论据：地基阶段一个 `npm view` 就拦下了会污染 4 路扇出的错误** |
| 5 | ACP spike | bridge 内嵌 `@anthropic-ai/claude-agent-sdk`，**不依赖独立 `claude` CLI**（本机也确实没有 `claude`）；但 Agent SDK 需鉴权（API key/订阅） | toolchain | 早稿假设的 `--add-dir/--mcp-config/--append-system-prompt` 是 `claude` **CLI** flag，bridge 不一定吃 → 注入机制降级为 spike 待验证项。前置检查（见 #2）要加一条：Agent SDK 鉴权可用性。「外部前置条件」清单需补鉴权 |
| 6 | ACP spike | bridge 用 `@agentclientprotocol/sdk@0.14.1`，与早稿写的 `@zed-industries/agent-client-protocol@0.4.5` 大版本/血缘都不同 | contract | Open Question Q1（版本对齐）不是「将来要做」，开工第一刻就撞上了。driving 侧 SDK 必须跟 bridge 内部依赖对齐，否则协议版本错配。坐实了「版本对齐」决策的必要性 |

| 7 | 写 .gitignore | 我顺手写的 `.claude/skills/*/` 会误伤仓库里**已提交**的 opsx/openspec dev skills | verification | 「用户自装 skill/tool 不提交」指的是**运行时** agent workspace（`~/.agent-team/`）里的，与仓库根的 dev 工具 `.claude/` 是两回事。agent 写忽略规则时极易混淆「运行时产物」与「仓库内 dev 资产」——`task_write` / 制品归档逻辑也要小心同名目录的语义分层 |
| 8 | pnpm install | pnpm 默认拦截依赖的 build script（esbuild postinstall），需显式 `allowBuilds` | toolchain | 环境前置检查（#2）再加一条：依赖装完要验证关键 native 依赖（esbuild 等）的 postinstall 已执行，否则 agent 跑 vitest 会莫名失败 |

| 9 | ACP 鉴权 | 误以为 bridge 需要单独的 `ANTHROPIC_API_KEY`/凭证；实测本机走**订阅 OAuth**（无 API key，凭证在 macOS Keychain `Claude Code-credentials` 项 + OAuth 刷新），bridge 自带 Agent SDK 应能直接读 | contract | **产品鉴权模型应「继承用户已登录的订阅 OAuth」，而非要求 API key**——用户用现成 Claude 订阅即可，无需额外配 key。这影响 proposal「外部前置条件」（改为：用户已登录 Claude 订阅即可）+ local-auth 的边界（agent 子进程鉴权 = 复用宿主登录态）。**待确认**：① bridge 子进程能否读到 Keychain 凭证；② 订阅 OAuth 跑自定义编排器是否符合 ToS（技术可行 ≠ 政策允许，需用户/官方确认） |

| 10 | ACP spike 完成 | live 往返跑通：装官方 `claude` CLI（v2.1.186）确认订阅登录 → `claude -p` headless 返回 SPIKE_OK → bridge `claude-code-acp` 经 `@agentclientprotocol/sdk` 的 initialize/newSession/prompt 往返成功，订阅 auth 直接复用、无需 key | contract | D7 最大风险退役。**注入机制实证**：workspace 走 `session/new.additionalDirectories`、MCP 走 `session/new.mcpServers`（必填），均为 ACP 协议参数而非 CLI flag。**意外收获**：bridge `agentCapabilities` 含 loadSession/fork/resume → crash 重 spawn 可 resume 会话，比"全靠 chatroom 重建上下文"更强，Wave 2/M3 可利用。**待落地**：system-prompt/hooks 注入口（hypothesis：cwd 的 CLAUDE.md + .claude/settings.json） |

| 11 | Wave 2a 整合 | 后端 core worker 的 mcp 模块有 7 处循环依赖（`mcp-server → tools/index → 各 tool →(type import)→ mcp-server`），**worker 的 tsc + vitest 全过却没发现**——因为 ESM + `import type` 下循环不报错，只有 dep-cruiser（开 `tsPreCompilationDeps`）能抓。架构师整合时 preflight 拦下，抽 `McpToolContext` 接口（context.ts）打破环 | verification | **子 agent 的自检覆盖不到跨文件结构性问题**（循环依赖、分层违规、跨 slice 耦合）——这类必须靠独立的 preflight 门禁 + 整合方复核。映射到产品：ci 工厂 / orchestrator 的 propose 校验应把"依赖纪律 lint"作为合并前强制门禁，不能只靠 agent 自测 tsc/test |

| 12 | 真实 smoke | 链路联调一次性暴露 4 个"单测全过但真跑就崩"的 bug：①fork 的 task-process 跑在 Node 22（shell PATH 的 node 非 nvm 24），better-sqlite3 原生模块 ABI 不匹配崩溃 ②acp-adapter 把 `protocolVersion` 传成 string（ACP 要 number）③http mcpServers 漏必填 `headers: []` ④**bridge 继承了 `CLAUDECODE`/`CLAUDE_CODE_*` env → 报 "cannot be launched inside another Claude Code session"**（spike 当初剥了、worker 没带进 adapter） | verification | **这些全是 tsc+vitest 抓不到、只有真实启动才暴露的集成 bug**——再次印证 M1"链路无卡点"必须有真跑验收，不能停在单测绿。产品启示：ci 工厂的验收必须包含"真实拉起一次"；agent-team 自身部署要锁 Node 版本（fork 用 execPath 继承）、adapter 要防御性剥宿主会话 env、外部依赖契约（ACP 字段类型/必填）要有集成测试兜底 |

## ✅ M1 链路打通（real-run 里程碑）

**首次真实端到端跑通**（手动 smoke，非单测）：建 task → fork task-process → 起 HTTP MCP server → planner 经 `claude-code-acp` bridge（订阅 OAuth 鉴权）spawn → planner 调 `chatroom_send`（HTTP MCP）→ 开场白「📋 任务理解 + 已知信息 + 待澄清问题」落进 `task.db` 的 `chatroom_messages`。这是 M1「链路无卡点」目标的达成标志。自举链路 seed→partial 的临界点已跨过：工具的核心回路能真实运转。

## 阶段性小结（截至 Phase 0 spike）

- **spike-first 已回本**：还没写一行产品代码，就靠 `npm view` 拦下 D7 里 3 处会扩散的错误契约（包名、SDK 血缘、注入机制假设）。若按「全自动一条龙」直接扇出，4 个 engineer 会照着不存在的 `claude-agent-acp` 写 adapter。
- **未完成项（需带鉴权的环境才能跑）**：bridge 实际启动 + `session/prompt` 往返 + 注入机制三选一的实测。本机无 Agent SDK 凭证，留到检查点后补。
- **对产品的最强启示**：planner 出 task-plan 时，对「声明的外部依赖」应有一道自动存在性校验（`npm view`/`which`），等价于把本次 spike 的动作产品化。
