# qa-verification Specification

## Purpose
TBD - created by archiving change m2-qa-role. Update Purpose after archive.

## Requirements

### Requirement: qa 输入独立来自规约(与 engineer 同上游)
qa SHALL 作为 harness 中独立的 verification 角色,其验收输入与 engineer 同上游,**直接来自规约**(planner 产出的 specs Scenario / 后续 pm-ux 的 acceptance / visual-contract),而非 engineer 的 `eng/test-report.md`。qa MUST 从规约独立派生可执行验收步,**全程不动 team project 的代码**;repair MUST 由 engineer 执行,qa 仅产出验收结论 + 现象/根因/修复方案。engineer 的 test-report MAY 作为 qa 的白盒补充参考,但 qa 任何 PASS/FAIL 结论 MUST 有自己运行时跑出的证据,MUST NOT 仅引用 test-report 作为结论依据。

#### Scenario: qa 从规约派生验收,不从 test-report 派生
- **WHEN** qa 启动一次验收
- **THEN** qa MUST 从规约(specs Scenario / acceptance / visual-contract)派生本次的可执行验收步
- **AND** qa MUST NOT 仅依据 `eng/test-report.md` 派生验收范围或锚点

#### Scenario: engineer test-report 作白盒参考但不作结论
- **WHEN** qa 引用 engineer 的 `eng/test-report.md`
- **THEN** 该引用 MUST 仅作为白盒补充参考(对账/质疑)
- **AND** 该锚点的 PASS/FAIL 结论 MUST 由 qa 自己运行时跑出的证据支撑,而非"engineer 报告说 PASS 所以 PASS"

#### Scenario: qa 不动代码
- **WHEN** qa 在任何阶段发现 FAIL 项
- **THEN** qa MUST 仅在报告里写明现象/根因/修复方案,并 `@engineer` 指派
- **AND** qa MUST NOT 直接修改 team project 的代码;repair MUST 由 engineer 执行

### Requirement: 发现式验收(自主发现,不被喂 bug)
qa SHALL 以"感知验收标准 → 逐条系统核实 → 自主发现偏差 → 报告 → 交 engineer repair"的流程验收。qa 的输入 MUST 只含**正向验收标准/交互预期**(来自 specs Scenario 等),MUST NOT 包含预先告知的 bug 清单;问题 MUST 由 qa 通过"实际 vs 预期"的比对自主发现。

#### Scenario: 验收标准作为输入,bug 不作为输入
- **WHEN** 启动一次 qa 验收
- **THEN** qa 收到的输入 MUST 是正向验收标准/交互预期(不含"哪里坏了"的描述)
- **AND** 任何被发现的缺陷 MUST 来自 qa 对标准的逐条核实,而非输入里的提示

#### Scenario: 发现后产出可执行报告
- **WHEN** qa 在核实中发现某锚点实际不符预期
- **THEN** 报告 MUST 为该项写明 `现象`、`根因`(解析)、`修复方案`
- **AND** qa MUST 用 `@engineer` 把该 FAIL 项指派给 engineer 修复

### Requirement: agent-browser 双轨道功能/视觉验证
qa SHALL 能用 `agent-browser` 驱动 team project 的运行实例做验证:轨道 A(功能 e2e —— 对流程锚点点页面并断言可见/可交互)与轨道 B(视觉/交互 —— 截图 + 可访问性树核对布局)。qa MUST 以运行时观察(而非仅源码推断)为功能/视觉锚点的证据。

#### Scenario: 功能 e2e 用浏览器证据
- **WHEN** qa 验收一条前端流程锚点(如"输入框发消息后消息出现在列表")
- **THEN** qa MUST 用 `agent-browser`(open/snapshot/click/fill)在运行实例上实际操作并断言结果
- **AND** 报告该锚点的证据 MUST 含浏览器快照/截图或交互结果,而非"读代码应该没问题"

#### Scenario: 视觉/交互锚点用截图核对
- **WHEN** qa 验收一条视觉/交互锚点(如"窄视口 header 不重叠")
- **THEN** qa MUST 用 `agent-browser` 截图 + 可访问性树在目标视口下核对
- **AND** 不符时报告 MUST 定位到具体元素/现象

### Requirement: 报告硬化(增量写 + 预算 + 证据闸)
qa SHALL 增量写 `qa/verification_report.md`(边验边追加,不在结束时一次性产出),以避免阶段超时丢失报告。qa MUST 遵守验收预算(最大命令数/文件数/时长,固定 acceptance matrix),MUST NOT 无界通读源码或扫全仓。声称任何锚点 PASS 前 qa MUST 在本轮有刚跑出的验证证据。

#### Scenario: 增量写防超时
- **WHEN** qa 完成对某一条锚点的核实
- **THEN** qa MUST 立即把该条结论+证据追加进 `qa/verification_report.md`
- **AND** 即便后续阶段被中断,已核实条目的报告 MUST 已落盘

#### Scenario: 预算内验收
- **WHEN** qa 进行一次验收
- **THEN** qa MUST 在固定 acceptance matrix + 命令/文件/时长预算内完成
- **AND** qa MUST NOT 逐文件通读无关源码或无界扫全仓

### Requirement: engineer 在 gate 内 verify-only → on-demand repair 两阶段工作模式
engineer SHALL 在 qa gate 内采用两阶段工作模式:**第一阶段 verify-only**(只跑固定验证命令 + 写 `eng/test-report.md`,MUST NOT 实现/重构无关代码);**第二阶段 on-demand repair**(仅当 qa 在 verification_report.md 中明确 FAIL 并 `@engineer` 指派后才进入,且 MUST 只处理被指派的 FAIL 项)。这是 engineer 的工作切片,与 qa 的时序解耦 —— qa 与 engineer **并行**从规约独立派生验收,不依赖 engineer 完成 test-report 才开始(详见"qa 输入独立来自规约"Requirement)。

#### Scenario: 第一阶段 engineer 不越权实现
- **WHEN** engineer 处于 gate 内的 verify-only 阶段
- **THEN** engineer MUST 只跑验证命令并写 `eng/test-report.md`
- **AND** engineer MUST NOT 改动与 qa-FAIL 修复无关的任何文件

#### Scenario: 第二阶段 repair 仅处理指派的 FAIL 项
- **WHEN** qa 在 `qa/verification_report.md` 含 FAIL 并 `@engineer` 指派具体项
- **THEN** engineer MUST 只修复被指派的 FAIL 项,然后交回 qa 复验该项
- **AND** engineer MUST NOT 借机改动指派项之外的代码

#### Scenario: qa 与 engineer 时序解耦
- **WHEN** engineer 进入 verify-only 阶段
- **THEN** qa MAY 同时独立从规约派生验收步并开始核实(无需等 engineer 完成 test-report)
- **AND** qa 的 PASS/FAIL 结论 MUST NOT 以 engineer test-report 的存在或内容为前置条件
