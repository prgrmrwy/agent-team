# agent-team — 项目上下文（给后续迭代的 AI）

> 本文件是项目的"入口地图"。任何接手本仓库的 AI **先读这里**，再按需深入 `openspec/` 下的权威规约。
> 设计原则、决策记录、需求规约都在 OpenSpec 里，本文件只做指路 + 速览，不重复正文。

## 这是什么

一个**单用户、本地 Web 应用**，编排多个 AI 编码 agent（经 Codex / Codex CLI）并行开发任务。
以 **chatroom 为中心上下文总线**，用**工厂（factory）模式**产出角色化 agent（planner / engineer / pm-ux / qa / anti / ci），
每个任务拉起一支 agent 团队，通过结构化状态机（S0–S11）协作。

自举背景（为什么用 AI 团队开发"AI 团队系统"）见 [docs/bootstrap-notes.md](docs/bootstrap-notes.md)。

## 权威文档（按这个顺序读）

1. **架构总纲**：[docs/architecture.md](docs/architecture.md)（v0.5）—— 完整愿景、6 工厂、12 态状态机、chatroom 协议、数据模型
2. **当前主规约**：[openspec/specs/](openspec/specs/) —— 已归档 change 同步后的权威行为规约（9 个 capability，`openspec validate --all --strict` 必须过）
   - [task-lifecycle](openspec/specs/task-lifecycle/spec.md) —— 当前状态机：M1/M2 已落地，含 S7 QA 与 S9 CI
   - [chatroom-protocol](openspec/specs/chatroom-protocol/spec.md) —— MCP 工具、频道、seat 状态机、受控写入
   - [agent-runtime](openspec/specs/agent-runtime/spec.md) —— 隔离模型、写权责、ACP/多 runtime、per-task 进程
   - [factory-system](openspec/specs/factory-system/spec.md) —— 工厂 YAML、planner/engineer/qa/ci 默认工厂、版本化
   - [artifact-management](openspec/specs/artifact-management/spec.md) —— 制品类型、目录约束、refs 锚定
   - [local-auth](openspec/specs/local-auth/spec.md) —— token 鉴权 / CVE 防护
   - [qa-verification](openspec/specs/qa-verification/spec.md) —— QA 双轨道发现式验收
   - [computer-runtime](openspec/specs/computer-runtime/spec.md) / [multi-runtime-agent-adapter](openspec/specs/multi-runtime-agent-adapter/spec.md) —— computer 抽象与 runtime adapter
3. **过程反馈**：[docs/bootstrap-notes.md](docs/bootstrap-notes.md) —— seed 阶段的踩坑与对设计的启示

> 改规约用 OpenSpec 流程（`openspec validate <change> --strict` 必须过），不要直接手改 `specs/` 主库。

## 当前状态（2026-06-25）

- **M1 完成并归档**：基础 monorepo、protocol、server、MCP、agent runtime、web skeleton、端到端 dogfood。
- **M2 完成并归档**：QA 工厂 + S7、CI 工厂 + S9、本地 CI stub、发现式验收、agent-browser 证据链。
- **M3 暂时 hold**：mcp-injection / seat-lifecycle / anti / pm-ux 独立工厂 / dashboard / subtask-handoff / real MR integration 均按需再开。
- **已做完一波较完整前端开发**：Sheikah Slate 视觉框架、首页 composer、task/chatroom、factory profile、右抽屉 profile、mention/skill picker、avatar working badge、done 流程等。
- **接下来主线**：前端优化 / polish / 可用性修补。优先从真实使用中撞到的 UI/交互问题下手，通常不需要新 OpenSpec change；涉及协议、状态机、工厂能力时再开 change。

## 技术栈速览（权威见 design.md D3/D4）

| 层 | 选型 |
|---|---|
| 运行时 | **Node 24+**（`.nvmrc`），**pnpm 11+**（corepack），ESM only，TypeScript 5.7+ |
| 后端 | express@5 · ws@8 · better-sqlite3（WAL）· execa@9 · zod · pino · vitest · tsx(dev)/tsup(build) |
| 前端 | React 19 · rsbuild · @tanstack/react-router + react-query · shadcn + base-ui · tailwind · zustand |
| Agent 驱动 | ACP（`@agentclientprotocol/sdk`）+ bridge `@zed-industries/claude-code-acp`；另有 `@openai/codex-sdk` / `codex-exec` adapter |
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
- **当前状态机**：`S0→S1→S2→S6→S7→[S9→]S10'→S11→done`。无 QA seat 时保留 `S6→S10'` 兼容；无 CI seat 时保留 `S7→S10'` 兼容。
- **当前工厂**：planner / engineer / qa / ci 已可用；pm-ux 与 anti 仍 hold。planner 临时兼任 pm-ux 的 acceptance / visual-contract 输出。
- **前端优化纪律**：优先保持 FSD 分层与现有 Sheikah Slate 视觉系统；小 polish 直接做，涉及协议/状态机/工厂职责变化再走 OpenSpec。
