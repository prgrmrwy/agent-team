# Skill Sources

工厂（factory）只引用**本目录下可见的 skill 名**。除内置的 openspec / factory 相关
skill 外，运行时用到的其它 skill 由使用者自行放置（软链或拷贝到本目录），并在此登记来源，
避免运行时到处扫描外部仓库。

工厂默认配置里出现的 skill 名（如 `deploy` / `ship-ticket` / `ui-impl` / `issue-context`
等）均为**通用占位示例**，指代「部署」「工单绑定」「UI 实现」「工单上下文」这类能力。
落地时替换为你自己环境中对应的 skill 即可。

| Skill | Source |
|---|---|
| `<your-skill>` | `<path-or-repo>` |
