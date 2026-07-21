# agent-team — 项目上下文（给后续迭代的 AI）

> 本文件是项目的"入口地图"。任何接手本仓库的 AI **先读这里**，再按需深入 `openspec/` 下的权威规约。
> 设计原则、决策记录、需求规约都在 OpenSpec 里，本文件只做指路 + 速览，不重复正文。

## 这是什么

一个**单用户、本地 Web 应用**，编排多个 AI 编码 agent（经 Claude Code / Codex CLI）并行开发任务。
以 **chatroom 为中心上下文总线**，用**工厂（factory）模式**产出角色化 agent（planner / engineer / pm-ux / qa / anti / ci），
每个任务拉起一支 agent 团队，通过结构化状态机（S0–S11）协作。

自举背景（为什么用 AI 团队开发"AI 团队系统"）见 [docs/bootstrap-notes.md](docs/bootstrap-notes.md)。

## 权威文档（按这个顺序读）

1. **架构总纲**：[docs/architecture.md](docs/architecture.md)（v0.5）—— 完整愿景、6 工厂、12 态状态机、chatroom 协议、数据模型
2. **当前权威规约**：[openspec/specs/](openspec/specs/)（行为规约，SHALL/MUST + Scenario，是验收基准；`openspec validate --all --strict` 必须过）：
   - [task-lifecycle](openspec/specs/task-lifecycle/spec.md) —— 状态机 / propose 三层校验 / 暂停恢复 abort
   - [chatroom-protocol](openspec/specs/chatroom-protocol/spec.md) —— MCP 工具 / 频道 / seat 状态机
   - [agent-runtime](openspec/specs/agent-runtime/spec.md) —— 隔离模型 / 写权责 / ACP 驱动 / per-task 进程
   - [factory-system](openspec/specs/factory-system/spec.md) —— 工厂 YAML / 三层配置 / 抽签 / 版本化
   - [artifact-management](openspec/specs/artifact-management/spec.md) —— 制品类型 / 目录约束 / refs 锚定
   - [local-auth](openspec/specs/local-auth/spec.md) —— token 鉴权 / CVE 防护
3. **过程反馈**：[docs/bootstrap-notes.md](docs/bootstrap-notes.md) —— seed 阶段的踩坑与对设计的启示

> 改规约用 OpenSpec 流程（`openspec validate <change> --strict` 必须过），不要直接手改 `specs/` 主库。

## 技术栈速览（权威见 design.md D3/D4）

| 层 | 选型 |
|---|---|
| 运行时 | **Node 24+**（`.nvmrc`），**pnpm 11+**（corepack），ESM only，TypeScript 5.7+ |
| 后端 | express@5 · ws@8 · better-sqlite3（WAL）· execa@9 · zod · pino · vitest · tsx(dev)/tsup(build) |
| 前端 | React 19 · rsbuild · @tanstack/react-router + react-query · shadcn + base-ui · tailwind · zustand |
| Agent 驱动 | ACP（`@agentclientprotocol/sdk`）+ bridge `@zed-industries/claude-code-acp`（内嵌 Agent SDK，需鉴权） |
| MCP | `@modelcontextprotocol/sdk`（chatroom-mcp，每 task 共享单实例） |

## 仓库结构（原则：尽量内聚，必须前后端共享才抽到 packages）

```
apps/web/        前端 SPA（FSD 6 层：app/pages/widgets/features/entities/shared）
apps/server/     后端（http / ws / mcp / domain / adapters / process）—— 工厂加载也内聚在这
packages/protocol/   唯一共享包：数据模型 zod schema + WS/REST/MCP 协议契约
tools/at-hook/   hook 上报脚本
根级：pnpm-workspace.yaml · tsconfig.base.json · biome.json · vitest.base.config.ts · .dependency-cruiser.cjs
```

## 纪律

- **依赖单向**：`pnpm preflight` 跑 dependency-cruiser（FSD 单向 + 后端 domain 不依赖传输层 + 跨 app 不互依）+ steiger（FSD）+ typecheck + test。违规即阻塞。
- **共享走 protocol**：前后端要共用的类型/schema 只放 `packages/protocol`，两端 `z.infer` 取类型，不写两份。
- **改一处全栈跟进**：协议变更先改 `packages/protocol`，再前后端跟。
- **当前范围**：planner / engineer / qa / ci 工厂与状态机 `S0→S1→S2→S6→S7→[S9→]S10'→S11→done` 已落地；pm-ux / anti 等按需引入。
