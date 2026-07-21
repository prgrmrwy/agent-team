---
name: "create-agent-team-factory"
description: "为 agent-team 仓库创建或更新本地 factory YAML"
---

# create-agent-team-factory

当用户要求“创建一个 factory”“新增一个 agent 角色”“改一个 factory 模板”时使用本技能。

## 目标

在当前仓库内创建或更新 `apps/server/src/domain/factory/defaults/<name>.yaml`。本技能只负责仓库文件，不走前端写入；factory 编辑 UI 当前保持只读。

## 必须收集的信息

如果用户没有提供，先询问缺失项，不要直接脑补：

- `name` / role：`planner`、`engineer`、`pm-ux`、`qa`、`anti`、`ci` 之一。
- `persona`：这个 factory 的角色气质和职责边界。
- `systemPromptTemplate`：系统提示主体；必须包含 `{{displayName}}`、`{{task.title}}`、`{{> agent.md}}`。
- `defaultNamePool`：至少 5 个中文展示名。
- primary model profile：`preferredModelProfile.provider`、`model`、可选 `reasoningEffort`。
- fallback model profile：至少确认是否需要 `fallbackModelProfiles[]`；若需要，收集 provider / model / reasoning。
- `recommendedSkills[]`。
- `recommendedCliTools[]`。
- `recommendedMcps[]`（如无则空数组）。
- `defaultPermissions.proposeTransitions[]`。
- `workingHabits[]`。
- `deliverables[]`。

## 生成要求

- YAML 必须符合 `packages/protocol/src/domain/factory.ts` 的 `Factory` schema。
- `coreMcps` 默认包含：

```yaml
coreMcps:
  - name: chatroom-mcp
    command: node
    args: []
```

- `lifecycle` 默认 `alwaysOn`。
- `preferredModelProfile` 和 `fallbackModelProfiles` 使用 provider-native model 字符串，不在 skill 内硬编码校验真实模型名。
- 修改已有 factory 时，除非用户明确要求，不要重写无关 prompt 段落。

## 验证

生成或更新 YAML 后，至少运行：

```bash
pnpm --filter @agent-team/server test -- src/domain/factory/factory.test.ts
```

如果改动触及协议 schema 或默认 factory 集合，再运行：

```bash
pnpm preflight
```

## 非目标

- 不实现前端 factory 编辑。
- 不做远端 computer / provider discovery。
- 不替用户决定未经确认的新角色权限边界。
