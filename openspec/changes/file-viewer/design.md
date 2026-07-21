# Design: file-viewer

## 决策

### D1：统一 FileViewer 组件(一处实现,两处复用)
`FileViewer({ taskId, path })`:取内容 + 按类型渲染。被**消息点击**和**workspace tab**共用。在右栏(`openRightPanel`)展示时设 `width: 800px`(`<aside>` 跟内容宽,无需改容器)。**永不开新页**。

渲染分派(按扩展名):
| 类型 | 渲染 |
|---|---|
| `.md` | `ReactMarkdown`(remarkGfm + remarkBreaks)— 复用现有 |
| 代码 `.tsx/.ts/.js/.jsx/.json/.yaml/.yml/.css/.txt/.sh`… | ```lang 代码围栏 + `rehype-highlight`(已是依赖)|
| 图片 `.png/.jpg/.jpeg/.gif/.svg/.webp` | `<img src={file 端点 raw 模式}>` |
| 其它 | `<pre>` 纯文本 |
| 找不到 | "文件不存在" 占位,**不报错** |

### D2：后端文件解析 —— chatroom workspace + worktree 双根
`GET /tasks/:id/file?path=<rel>`(+ `&raw=1` 图片走二进制流):
- 解析根 = **① task workdir(chatroom workspace)② worktree 绝对路径**(取自 bootstrap resource `primary-worktree`)。
- 对每个根 `path.resolve(root, rel)` 后校验 `resolved` 仍在 `root` 内(防 `../` 穿越);**按 ① → ② 顺序**找,命中即返。
- 返回 `{ content, path, ext, root: 'workspace'|'worktree' }`;raw 模式直接 `sendFile` + content-type。
- 都没找到 → 404(前端渲染"文件不存在")。

### D3：消息里可点的范围(只认两类,不全文扫)
- **markdown 链接 `[xxx](href)` 且 href 非 `http(s)://`** → 本地路径,`onClick` → openRightPanel(FileViewer)。
- **inline code 内匹配"路径 + 扩展名"正则**(含 `/` 或形如 `name.ext`)→ 可点。
- http(s) 链接 → 普通外链(新开浏览器)。
- **不扫普通正文**(避免把带斜杠的散文误判成链接)。配合 D6 让 agent 主动用链接语法。

### D4：渲染复用 rehype-highlight
代码高亮无需新依赖(`rehype-highlight@7` 已在)。FileViewer 把 raw code 包成 ```<ext> 围栏喂 ReactMarkdown + rehype-highlight;md 文件直接渲染(其内代码块也自动高亮)。

### D5：workspace tab(chatroom profile 第 5 个 tab)—— 只 chatroom workspace,不含 worktree
现有 `ChatroomTab = meta|seats|usage|history` → 加 `workspace`。
- **chatroom workspace 目录树**:`GET /tasks/:id/workspace/ls?path=<dir>` 返回**单层** entries(`{ name, type: 'dir'|'file' }`)。前端**递归 + 懒加载**:点目录才拉下一层,**展开时显 loading icon**。文件点击 → FileViewer(右栏 800px)。
  - 排除噪声:`task.db*`、`chatroom.jsonl`(可选,或灰显)。
- **worktree 不在此 tab**。

### D5b:worktree 打开走 chatroom 顶部那行
worktree 已经在 chatroom 顶部的 bootstrap 状态行显示(`worktree·sw/lean <绝对路径>`,见 BootstrapProgress/ResourceRow)。直接**把那行的 worktree 路径做成可点** → `vscode://file/<worktree 绝对路径>` 打开 VSCode。不在 workspace tab 里另放 worktree 区。

### D6:agent 制品引用用链接语法
更新 planner/engineer/qa/ci `systemPromptTemplate` + `agent.md`:在 chatroom 提制品/文件时**用 markdown 链接** `[plan/task-plan.md](plan/task-plan.md)`,而非裸文本。这样人类点得开(D3 只认链接 + inline-code 路径)。

### D7:安全 / 边界
- path 越界校验是硬约束(D2),两根都校验。
- 大文件:文本 >256KB 截断 + 提示"已截断";图片按原样(浏览器扛)。
- 二进制非图片:不渲染,提示"二进制文件,不支持预览"。

## 复用 / 不做
- **复用**:`rehype-highlight`、`openRightPanel`/`<aside>`、artifact_get 的 path 校验范式、bootstrap resource 的 worktree 路径。
- **不做**:worktree 目录树浏览(只给 vscode 链接);文件编辑(只读);跨 task 文件访问。

## 风险
- **R1 inline-code 路径误判**:正则太松会把非路径 code 变蓝。缓解:要求含 `/` 或明确 `name.ext` 且扩展名在白名单。
- **R2 worktree 未 ready**:bootstrap 没好时 worktree 根不存在 → file 解析只用 workspace 根;workspace tab 的 worktree 区显示"worktree 未就绪"。
- **R3 vscode://**:需用户装 VSCode + 系统注册了 `vscode://` 协议;打不开是环境问题,非前端 bug(可加 fallback 提示复制路径)。
- **R4 懒加载树状态**:展开/折叠 + loading 用本地组件 state,切 task 随 profile 重挂载重置。
