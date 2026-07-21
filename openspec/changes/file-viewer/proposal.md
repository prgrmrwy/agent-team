# Proposal: file-viewer

## Why

chatroom 里 agent 经常提到制品/文件(`plan/task-plan.md`、`eng/commits-1.txt`、源码 `apps/.../*.tsx`),但**不可点、看不了内容** —— 人类要么去翻磁盘,要么让 agent 把内容贴进 chatroom(噪声大)。同时 task 的 workspace(chatroom workdir + worktree)对人类是个黑盒,没有入口浏览。

需要:**点一下文件就能在右栏看内容**(md / 代码 / 图片),以及一个**浏览 workspace 的入口**。

## What Changes

### 1. 统一 FileViewer(800px 右栏)
一个组件,被两处复用:消息里点文件、workspace tab 里点文件。`GET /tasks/:id/file?path=<rel>` 取内容,按扩展名渲染:
- `.md` → ReactMarkdown(remarkGfm + remarkBreaks)
- 代码(`.tsx/.ts/.js/.json/.yaml/.txt`…)→ ```代码围栏 + rehype-highlight(已有依赖)
- 图片(`.png/.jpg/.svg`…)→ `<img>`(走 raw 模式端点)
- 其它 → `<pre>` 纯文本
- 找不到 → "文件不存在",不报错。**永不开新页**,只在右栏。

### 2. 后端文件解析(chatroom workspace + worktree 双根)
`GET /tasks/:id/file` 按序在 **task workdir(chatroom workspace)→ worktree** 里找 `path`;两根都做 `path.resolve` + 越界校验(防 `../` 穿越);命中即返。worktree 绝对路径来自 bootstrap resource。

### 3. 消息里文件引用可点(不开新页)
- **markdown 链接 `[xxx](href)` 且 href 非 http(s)** → 当本地路径,点击 → FileViewer。
- **inline code 里匹配"路径+扩展名"的**(如 \`plan/task-plan.md\`)→ 可点 → FileViewer。**不全文扫**(避免误判普通带斜杠文本)。
- http(s) 链接 → 维持普通外链。

### 4. agent 输出制品优先用链接语法
更新 planner/engineer/qa/ci + agent.md:写制品地址用 `[plan/task-plan.md](plan/task-plan.md)` 而非裸文本 → 天然可点(配合 §3 的"只认链接 + inline-code 路径")。

### 5. chatroom profile 加 workspace tab(仅 chatroom workspace)
现有 tab(meta/seats/usage/history)加第 5 个 **workspace**,列 **chatroom workspace**(task workdir)目录树:**递归 + 懒加载**(点目录才拉下一层,展开时 loading icon)。文件点击 → 同一个 FileViewer。**不含 worktree。**

### 6. worktree 走 chatroom 顶部那行打开 VSCode
worktree 已显示在 chatroom 顶部 bootstrap 状态行(`worktree·sw/lean <绝对路径>`)。把那行的路径做成可点 → `vscode://file/<worktree 绝对路径>` 打开 VSCode。不在 workspace tab 里另放 worktree。

## Impact

- **New capability spec**: `workspace-viewer`(文件查看 / workspace 浏览 / 可点引用 / vscode 链接)。
- **Affected spec**: `factory-system`(agent 制品引用用链接语法的约定)。
- **Affected code**:
  - server: 新增 `GET /tasks/:id/file`(内容 + raw 图片)、`GET /tasks/:id/workspace/ls`(单层目录列表,懒加载);worktree 路径取自 bootstrap resource。
  - web: 新增 `FileViewer` 组件;chatroom MessageRow markdown `a`/`code` 接 onClick → openRightPanel(FileViewer);新增 workspace tab(懒加载树,仅 chatroom workspace);顶部 bootstrap 行 worktree 路径做成 vscode:// 可点;复用 `openRightPanel`(<aside> 跟内容宽,FileViewer 设 800px)。
  - factory yaml:planner/engineer/qa/ci + agent.md 加"制品用链接语法"。
- **正交**:与 derive-presence、phase-driven 都正交(纯查看/浏览,不碰编排/状态)。
- **复用既有**:`rehype-highlight`(代码高亮,已是依赖)、`openRightPanel`/`<aside>`(右栏)、artifact_get 的 path 越界校验范式。
