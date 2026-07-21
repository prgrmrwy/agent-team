# factory-system (delta: file-viewer)

## ADDED Requirements

### Requirement: agent 制品引用用 markdown 链接语法

工厂 systemPromptTemplate(planner/engineer/qa/ci)+ agent.md SHALL 约定:agent 在 chatroom 提及自己产出/引用的制品或文件路径时,**用 markdown 链接** `[<相对路径>](<相对路径>)`(而非裸文本),以便人类在前端点击打开(file-viewer 只把链接 + inline-code 路径识别为可点)。

#### Scenario: 交接时用链接

- **WHEN** engineer 在 chatroom 交接,引用 `eng/test-report-1.md`
- **THEN** SHALL 写成 `[eng/test-report-1.md](eng/test-report-1.md)` 而非裸文本

#### Scenario: planner 列制品用链接

- **WHEN** planner propose 时列出 `plan/task-plan.md` 等制品
- **THEN** SHALL 用链接语法,使其在前端可点开
