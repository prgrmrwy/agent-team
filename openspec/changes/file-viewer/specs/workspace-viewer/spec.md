# workspace-viewer (delta: file-viewer)

## ADDED Requirements

### Requirement: 文件内容查看端点(双根解析 + 越界校验)

`GET /tasks/:id/file?path=<rel>` SHALL 在 **chatroom workspace(task workdir)→ worktree** 两个根中按序解析 `path`,命中即返文件内容。每个根 MUST 做 `path.resolve` 后校验解析结果仍在该根内(拒绝 `../` 穿越)。worktree 绝对路径取自 bootstrap resource。两根都未命中 → 404。

支持 `&raw=1` 以二进制流 + 正确 content-type 返回(图片用)。文本 >256KB SHALL 截断并标记。

#### Scenario: 在 workspace 命中

- **WHEN** `GET /tasks/:id/file?path=plan/task-plan.md`
- **THEN** 返回该文件内容 + `{ root: 'workspace', ext: 'md' }`

#### Scenario: 在 worktree 命中源码

- **GIVEN** workspace 内无 `apps/web/src/App.tsx`,worktree 内有
- **WHEN** `GET /tasks/:id/file?path=apps/web/src/App.tsx`
- **THEN** 返回 worktree 内该文件内容 + `{ root: 'worktree' }`

#### Scenario: 拒绝路径穿越

- **WHEN** `path` 解析后落在 workspace 与 worktree 之外(如 `../../etc/passwd`)
- **THEN** MUST 拒绝(不返回该文件)

#### Scenario: 找不到

- **WHEN** 两根都没有该 path
- **THEN** 返回 404;前端渲染"文件不存在",不报错

### Requirement: workspace 单层目录列表端点(懒加载)

`GET /tasks/:id/workspace/ls?path=<dir>` SHALL 返回 task workdir 下该目录的**单层** entries(`{ name, type: 'dir'|'file' }`),供前端递归懒加载目录树。`path` 同样做越界校验。

#### Scenario: 列单层

- **WHEN** `GET /tasks/:id/workspace/ls?path=plan`
- **THEN** 返回 `plan/` 下的直接子项(文件 + 子目录),不递归

### Requirement: 统一 FileViewer 按类型渲染

前端 SHALL 有统一 `FileViewer` 组件,被消息点击与 workspace tab 复用;按扩展名渲染:`.md`→Markdown、代码→语法高亮、图片→`<img>`、其它→纯文本、找不到→占位。在右栏展示时宽 800px,**永不开新页**。

#### Scenario: 渲染 markdown

- **WHEN** FileViewer 打开 `.md` 文件
- **THEN** 用 ReactMarkdown(GFM + 换行)渲染,内嵌代码块语法高亮

#### Scenario: 渲染代码

- **WHEN** FileViewer 打开 `.tsx`
- **THEN** 以语法高亮的代码块渲染

#### Scenario: 渲染图片

- **WHEN** FileViewer 打开 `.png`
- **THEN** 以 `<img>` 渲染(raw 模式端点)

### Requirement: 消息内文件引用可点(只认链接 + inline-code 路径)

chatroom 消息渲染 SHALL 把以下两类识别为可点本地文件,点击在右栏 FileViewer 打开(不开新页):
1. markdown 链接 `[xxx](href)` 且 `href` 非 `http(s)://`;
2. inline code 内匹配"路径 + 扩展名"模式的串。

`http(s)://` 链接 MUST 维持普通外链。普通正文 MUST NOT 被全文扫描(避免误判)。

#### Scenario: 非 http 链接可点

- **WHEN** 消息含 `[task-plan](plan/task-plan.md)`
- **THEN** 点击在右栏 FileViewer 打开该文件,不跳新页

#### Scenario: http 链接维持外链

- **WHEN** 消息含 `[doc](https://example.com)`
- **THEN** 点击按普通外链处理

### Requirement: worktree 经 chatroom 顶部状态行用 vscode:// 打开

worktree 已显示在 chatroom 顶部 bootstrap 状态行(`worktree·<provider>/<mode> <绝对路径>`)。该行的 worktree 路径 SHALL 可点,点击触发 `vscode://file/<worktree 绝对路径>` 用 VSCode 打开。MUST NOT 在 workspace tab 或前端任何处列 worktree 目录树。

#### Scenario: 点顶部 worktree 路径

- **WHEN** 用户点 chatroom 顶部状态行里的 worktree 路径
- **THEN** 触发 `vscode://file/<abs>` 打开 VSCode

#### Scenario: workspace tab 不含 worktree

- **WHEN** 用户打开 workspace tab
- **THEN** 只看到 chatroom workspace(task workdir)目录树,无 worktree 区
