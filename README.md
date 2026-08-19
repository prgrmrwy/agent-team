# Agent Team

一个单用户的本地 Web 应用,把多个 AI 编码 agent 编排成一支团队,并行开发同一个任务。

每个任务会拉起一支**角色化的 agent 团队**(planner / engineer / qa / ci),由**工厂(factory)**
模式产出。它们以 **chatroom 作为共享上下文总线**协作,沿一条结构化状态机推进任务:
`S0 → S1 → S2 → S6 → S7 → [S9 →] S10' → S11 → done`。
你在浏览器里全程在场:提一个任务、看着 agent 讨论和干活、最后确认收尾。

> 本项目是一次自举实验 —— 用 AI 团队来开发这套「AI 团队」系统。
> 过程中的踩坑与反思见 [`docs/bootstrap-notes.md`](docs/bootstrap-notes.md)。

## 它是怎么工作的

- **chatroom 作为上下文总线** —— 计划、制品、阶段变更、座位状态等任务信息全部流经一个共享
  chatroom,以 MCP 工具的形式暴露给 agent。agent 按需读取,而不是互相拷贝状态。
- **工厂模式** —— 每个角色是一份带版本的 YAML 工厂
  ([`apps/server/src/domain/factory/defaults/`](apps/server/src/domain/factory/defaults/)),
  定义人设、system prompt、推荐的 skill / 工具、权限和模型配置。
- **按任务隔离** —— 每个任务跑在独立进程里,拥有自己的 git worktree 和 SQLite 库,
  落在 `DATA_HOME`(默认 `~/.agent-team/`)下。
- **Agent 驱动** —— Claude 经 ACP(`@agentclientprotocol/sdk`)接入,Codex 经官方 SDK 接入,
  两者由统一的 `CliAdapter` 接口抹平。

完整设计见 [`docs/architecture.md`](docs/architecture.md)。

## 前置依赖

- **Node.js 24+**(见 `.nvmrc`)和 **pnpm 11+**(经 corepack 启用)。
- 至少一个**已完成鉴权**的 AI 编码 CLI,供 agent 驱动:
  - **Claude Code** —— 默认运行时,经 `@zed-industries/claude-code-acp` 桥接;
  - **Codex CLI** —— 备选运行时,若 `codex` 不在 `PATH` 上,用 `AGENT_TEAM_CODEX_BIN` 指定路径。
- `git`;若要用 CI 工厂的真实(非 stub)模式,还需要 `gh`。

## 快速开始

```bash
# 1. Node + pnpm
corepack enable
nvm use            # 或自行确保 Node 24+

# 2. 安装依赖
pnpm install

# 3. 配置(可选 —— 首次启动会自动生成 token)
cp .env.example .env

# 4. 起后端 + 前端
pnpm --filter @agent-team/server dev    # http://localhost:3001
pnpm --filter @agent-team/web dev       # http://localhost:5173
```

打开 http://localhost:5173。前端用本地 `AGENT_TEAM_TOKEN` 鉴权(首次启动 server 时自动生成并
写入 `.env`)。在首页输入框创建一个任务,就能看到团队开始工作。

全部配置项见 [`.env.example`](.env.example)。

## 常用脚本

| 命令 | 作用 |
|---|---|
| `pnpm dev` | 并行启动所有 workspace 的 dev server |
| `pnpm build` | 构建所有 workspace |
| `pnpm test` | 跑 server + protocol 单元测试 |
| `pnpm preflight` | 依赖规则(dependency-cruiser)+ FSD 规则(steiger)+ 类型检查 + 测试 |

## 仓库结构

```
apps/web/          前端 SPA(React 19,FSD 分层:app/pages/widgets/features/entities/shared)
apps/server/       后端(http / ws / mcp / domain / adapters / process)
packages/protocol/ 唯一共享包:zod schema + WS/REST/MCP 协议契约
tools/at-hook/     hook 上报脚本
openspec/          权威行为规约(校验:openspec validate --all --strict)
docs/              架构与设计文档
```

架构纪律(由 `pnpm preflight` 强制):FSD 各层依赖单向流动、后端 `domain` 不依赖任何传输层、
前后端要共用的东西只能放在 `packages/protocol`。

## 安全说明

这是一个**单用户本地应用**,设计上假定你在自己的机器上跑自己的任务。因此 agent 运行时默认是
放开的:Codex 侧使用 `sandboxMode: 'danger-full-access'` + `approvalPolicy: 'never'`,
ACP 侧对权限请求自动同意第一个选项。这样 agent 才能真实驱动浏览器、跑 git hook、执行部署。

也就是说,**agent 拥有你本机的完整权限,且不会向你请求确认**。如果你要在不受信任的环境里跑,
或想收紧权限,请先修改
[`codex-sdk-adapter.ts`](apps/server/src/adapters/cli/codex-sdk-adapter.ts) 与
[`acp-adapter.ts`](apps/server/src/adapters/cli/acp-adapter.ts) 中的对应策略。

## 文档

- [`docs/architecture.md`](docs/architecture.md) —— 完整架构(愿景、工厂、状态机、chatroom
  协议、数据模型)。
- [`openspec/specs/`](openspec/specs/) —— 权威行为规约(SHALL/MUST + 场景)。
- `AGENTS.md` / `CLAUDE.md` —— 给在本仓库里迭代的 AI 看的入口地图。

## 许可证

[MIT](LICENSE) © 2026 prgrmrwy
