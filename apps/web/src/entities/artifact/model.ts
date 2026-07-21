export type { Artifact, ArtifactType } from '@agent-team/protocol'

import type { ArtifactType } from '@agent-team/protocol'

export const ARTIFACT_TYPE_LABEL: Record<ArtifactType, string> = {
  proposal: '提案',
  acceptance: '验收标准',
  'visual-contract': '视觉合约',
  design: '设计文档',
  tasks: '任务列表',
  decisions: '决策记录',
  'test-report': '测试报告',
  'verification-report': '验证报告',
  'verification-loop': '验证循环',
  'anti-round-1': '反驳第 1 轮',
  'anti-round-2': '反驳第 2 轮',
  'ci-report': 'CI 报告',
  retrospective: '复盘',
  'task-plan': '任务计划',
  'phase-notices': '阶段通知',
  other: '其他',
}
