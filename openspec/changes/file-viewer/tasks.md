# Tasks: file-viewer

## 1. 后端端点(双根解析 + 懒加载列目录)

- [x] 1.1 解析 worktree 绝对路径 helper(从 bootstrap resource `primary-worktree` 读 path)
- [x] 1.2 `GET /tasks/:id/file?path=`:按 workspace→worktree 解析 + 两根越界校验;返回 `{content, path, ext, root}`;文本 >256KB 截断标记;`&raw=1` 二进制流 + content-type(图片);都没命中 → 404
- [x] 1.3 `GET /tasks/:id/workspace/ls?path=`:返回单层 entries(`{name,type}`)+ 越界校验
- [x] 1.4 端点单测(命中 workspace / 命中 worktree / 越界拒绝 / 404 / ls 单层)

## 2. FileViewer 组件(统一,800px)

- [x] 2.1 `FileViewer({taskId, path})`:fetch 内容 + 按扩展名分派渲染(md / 代码 rehype-highlight / 图片 img / pre / 找不到占位)
- [x] 2.2 右栏用法:`openRightPanel('file:'+path, <FileViewer/>)`,root 设 `width:800px`
- [x] 2.3 大文件/二进制非图片的降级提示

## 3. 消息内文件引用可点

- [x] 3.1 MessageRow ReactMarkdown `a` 组件:href 非 http(s) → onClick 打开 FileViewer;http(s) → 外链
- [x] 3.2 `code`(inline)组件:匹配"路径+扩展名"正则 → 可点 → FileViewer;不匹配按普通 code
- [x] 3.3 PartialBubble / ThinkingSection 的 markdown 同步接同一套(若共用 components 则一处改)

## 4. workspace tab(chatroom profile)+ 顶部 worktree 链接

- [x] 4.1 `ChatroomTab` 加 `workspace`;TabBar 加项
- [x] 4.2 懒加载目录树组件:点目录拉 `workspace/ls` 下一层,展开时 loading icon,折叠/展开本地 state
- [x] 4.3 文件点击 → FileViewer(右栏 800px);workspace tab **不含 worktree**
- [x] 4.4 chatroom 顶部 bootstrap 状态行的 worktree 路径做成可点 → `vscode://file/<abs>`(worktree resource 的绝对路径);未就绪时不可点

## 5. agent 制品用链接语法(prompt)

- [x] 5.1 planner/engineer/qa/ci systemPromptTemplate + agent.md 加"制品引用用 `[path](path)` 链接语法";相关 factory version bump

## 6. 验证

- [x] 6.1 `pnpm preflight` 全绿(typecheck + test + dep-cruiser + steiger)
- [x] 6.2 端到端:消息里链接/inline-code 路径点开 → 右栏看 md/代码/图片;找不到→占位;http 链接维持外链
- [x] 6.3 workspace tab:递归懒加载浏览 task workdir、点文件看内容、worktree vscode 链接可点
- [x] 6.4 `openspec validate file-viewer --strict`
