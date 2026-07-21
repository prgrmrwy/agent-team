/**
 * 组 12: propose-handler.ts
 * 三层校验（task-lifecycle spec § propose 三层校验）：
 *   Layer 1（硬）：deliverables 文件存在且非空
 *   Layer 2（硬）：markdown AST schema（关键 section 不缺）
 *   Layer 3（软）：LLM lint，默认关闭（接口预留）
 */

import fs from 'node:fs'
import path from 'node:path'
import type { Factory, TaskState } from '@agent-team/protocol'
import type { Logger } from '../../util/logger.js'

export interface ProposeEvidence {
  artifacts: string[]
  note?: string
}

/**
 * task-bootstrap-lifecycle phase 5.4: releasing→done 校验 bootstrap resources 是否都已终态。
 * 注入式由 task_state_propose handler 传入(domain 不直接读 DB)。
 */
export interface ResourceTerminalChecker {
  (taskId: string): { allTerminal: boolean; nonTerminalIds: string[]; total: number }
}

export interface ValidationResult {
  ok: boolean
  layer?: 1 | 2 | 3
  reason?: string
}

/**
 * Layer 2 schema：每种**制品文件**需要的 markdown section 集合（按文件名索引）。
 * 跨 target state 复用同一个制品时（如 eng/test-report.md 在 S6→S10' 和 S6→S7 都用），
 * 不会被另一个状态需要的 section 误伤（如 qa/verification_report.md 没有 `# Test Report`）。
 */
const REQUIRED_SECTIONS_BY_FILE: Record<string, string[]> = {
  'plan/task-plan.md': ['## seatPlan', '## 验收锚点'], // planner S1→S2
  'eng/test-report.md': ['# Test Report', '## 结果'], // engineer S6→S10' / S6→S7
  'qa/verification_report.md': ['## 最终结论'], // qa S7→S10' / S7→S6（FAIL 内容由 L2b 二次校验）
  'ci/ci_report.md': ['## ready2merge'], // ci S9→S10'（ready2merge 值由 L2c 二次校验）
  'retro/retrospective.md': ['## 任务概要'], // planner S11→done / releasing→done
  'retro/archive-plan.md': ['## resources'], // planner releasing→done(task-bootstrap-lifecycle phase 5)
}

/**
 * 多版本 deliverable 兼容:agent 每轮 propose 可写带版本号的文件
 * (eng/test-report-1.md, eng/commits-2.txt, qa/verification_report-3.md)。
 * 给定一个带版本号的相对路径,返回去掉 `-<n>` 后的"基名",用于 L2 schema 查表。
 * 不带版本号的路径原样返回。
 */
function stripVersionSuffix(relPath: string): string {
  // 'eng/test-report-2.md' → 'eng/test-report.md'
  // 'eng/commits-1.txt' → 'eng/commits.txt'
  // 'qa/verification_report-3.md' → 'qa/verification_report.md'
  return relPath.replace(/-(\d+)(\.[^.]+)$/, '$2')
}

/**
 * 在 taskWorkdir 下找某个 base 路径的最新版本(qa/verification_report.md →
 * qa/verification_report-<max-n>.md)。无任何带版本的文件时返回 baseRel。
 */
function findLatestVersionedFile(taskWorkdir: string, baseRel: string): string {
  const m = baseRel.match(/^(.+)(\.[^.]+)$/)
  if (!m) return baseRel
  const stem = m[1]! // 'qa/verification_report'
  const ext = m[2]! // '.md'
  const dir = path.dirname(baseRel)
  const absDir = path.join(taskWorkdir, dir)
  if (!fs.existsSync(absDir)) return baseRel
  const baseNameStem = path.basename(stem) // 'verification_report'
  const pattern = new RegExp(`^${baseNameStem}-(\\d+)${ext.replace('.', '\\.')}$`)
  let maxN = 0
  for (const f of fs.readdirSync(absDir)) {
    const mm = f.match(pattern)
    if (mm) {
      const n = parseInt(mm[1]!, 10)
      if (n > maxN) maxN = n
    }
  }
  if (maxN === 0) return baseRel
  return `${stem}-${maxN}${ext}`
}

/**
 * 运行三层校验。
 * @param taskWorkdir  task 工作目录（绝对路径）
 * @param targetState  目标状态
 * @param factory      发起 propose 的角色工厂
 * @param log          logger
 * @param currentState 当前状态（用于上下文敏感校验，如 S7→S10' 要求 qa 报告无 FAIL）
 */
export async function validatePropose(
  taskWorkdir: string,
  targetState: TaskState,
  factory: Factory,
  evidence: ProposeEvidence,
  log: Logger,
  currentState?: TaskState,
  opts?: { taskId?: string; resourceTerminalChecker?: ResourceTerminalChecker },
): Promise<ValidationResult> {
  // Layer 1：只校验 evidence.artifacts 中的文件（agent 本次 propose 声明的交付物）
  // 工厂 deliverables 是跨整个生命周期的声明，单次 propose 只需提交当前阶段的证据。
  // 若 agent 未提供 evidence.artifacts，fallback 到校验工厂全量 deliverables（向后兼容）。
  const checkList =
    evidence.artifacts.length > 0
      ? evidence.artifacts.filter((p) => factory.deliverables.includes(p))
      : factory.deliverables

  for (const relPath of checkList) {
    const absPath = path.join(taskWorkdir, relPath)
    if (!fs.existsSync(absPath)) {
      const reason = `${relPath} not found at ${absPath}`
      log.warn({ reason }, 'propose rejected (L1: file missing)')
      return { ok: false, layer: 1, reason }
    }
    const stat = fs.statSync(absPath)
    if (stat.size === 0) {
      const reason = `${relPath} is empty`
      log.warn({ reason }, 'propose rejected (L1: empty file)')
      return { ok: false, layer: 1, reason }
    }
  }

  // Layer 2:markdown AST schema(按制品文件名索引;未注册的文件跳过)
  // 兼容多版本:agent 传 'eng/test-report-2.md' 走 stripVersionSuffix → 'eng/test-report.md' 查表
  for (const relPath of checkList) {
    const lookupKey = stripVersionSuffix(relPath)
    const requiredSections = REQUIRED_SECTIONS_BY_FILE[lookupKey]
    if (!requiredSections) continue
    const absPath = path.join(taskWorkdir, relPath)
    if (!absPath.endsWith('.md')) continue

    const content = fs.readFileSync(absPath, 'utf-8')
    for (const section of requiredSections) {
      if (!content.includes(section)) {
        const reason = `${relPath} missing required section '${section}'`
        log.warn({ reason }, 'propose rejected (L2: missing section)')
        return { ok: false, layer: 2, reason }
      }
    }
  }

  // Layer 2b(m2-qa-role):S7 → S10' 必须 qa/verification_report 存在且无 FAIL 结论
  // 多版本兼容:从 evidence 找 qa report(可能带版本号);若没,fallback 找最新版本号文件
  if (currentState === 'S7' && targetState === "S10'") {
    const qaReportRel =
      evidence.artifacts.find((p) => stripVersionSuffix(p) === 'qa/verification_report.md') ??
      findLatestVersionedFile(taskWorkdir, 'qa/verification_report.md')
    const qaReportAbs = path.join(taskWorkdir, qaReportRel)
    if (!fs.existsSync(qaReportAbs)) {
      const reason = `${qaReportRel} 不存在(S7→S10' 要求 qa 出具验收报告)`
      log.warn({ reason }, 'propose rejected (L2b: qa report missing)')
      return { ok: false, layer: 2, reason }
    }
    const content = fs.readFileSync(qaReportAbs, 'utf-8')
    if (/(结论|最终结论)[:：]\s*FAIL/i.test(content)) {
      const reason = `${qaReportRel} 含 FAIL 结论(S7→S10' 要求全锚点 PASS;请先 qa-propose-repair 回 S6 修复)`
      log.warn({ reason }, 'propose rejected (L2b: qa report has FAIL)')
      return { ok: false, layer: 2, reason }
    }
  }

  // Layer 2c（m2-ci-factory）：S9 → S10' 必须 ci/ci_report.md 存在且含 `ready2merge: true` 标记
  if (currentState === 'S9' && targetState === "S10'") {
    const ciReportRel = 'ci/ci_report.md'
    const ciReportAbs = path.join(taskWorkdir, ciReportRel)
    if (!fs.existsSync(ciReportAbs)) {
      const reason = `${ciReportRel} 不存在（S9→S10' 要求 ci 出具 CI 报告）`
      log.warn({ reason }, 'propose rejected (L2c: ci report missing)')
      return { ok: false, layer: 2, reason }
    }
    const content = fs.readFileSync(ciReportAbs, 'utf-8')
    // 与 L2b 同风格,信号锚是 `ready2merge: true` 或节头 `## ready2merge` 后下一行 `true`(忽略大小写、允许冒号/空白/换行分隔)
    if (!/ready2merge[\s:：]+true\b/i.test(content)) {
      const reason = `${ciReportRel} 未含 \`ready2merge: true\` 标记（S9→S10' 要求 ci 显式标 ready;请检查 MR/CI/comment 是否全部清空）`
      log.warn({ reason }, 'propose rejected (L2c: ready2merge missing or false)')
      return { ok: false, layer: 2, reason }
    }
  }

  // Layer 2d(task-bootstrap-lifecycle phase 5.4): releasing → done 校验
  // - retrospective.md 始终必须
  // - archive-plan.md 仅当 task 真有 bootstrap resources 时必须(没 resources
  //   等于没什么要 archive,强写一份"无资源"的 plan 没意义,planner 也会因此卡住)
  // - 所有 resources 必须已进入终态(retained/removed/archived/needs-review)
  //   needs-review 视为终态(spec D7: 不阻塞 done,但 archive-plan 里说明)
  if (currentState === 'releasing' && targetState === 'done') {
    const retroAbs = path.join(taskWorkdir, 'retro/retrospective.md')
    if (!fs.existsSync(retroAbs) || fs.statSync(retroAbs).size === 0) {
      const reason = `retro/retrospective.md 缺失或为空(releasing→done 必须产出复盘文档)`
      log.warn({ reason }, 'propose rejected (L2d: retrospective missing)')
      return { ok: false, layer: 2, reason }
    }
    const check = opts?.taskId && opts.resourceTerminalChecker
      ? opts.resourceTerminalChecker(opts.taskId)
      : { allTerminal: true, nonTerminalIds: [], total: 0 }
    if (!check.allTerminal) {
      const reason = `bootstrap resources 仍未进入终态: ${check.nonTerminalIds.join(', ')}(orchestrator 需先执行 runner.release)`
      log.warn({ reason }, 'propose rejected (L2d: bootstrap resources non-terminal)')
      return { ok: false, layer: 2, reason }
    }
    if (check.total > 0) {
      const planAbs = path.join(taskWorkdir, 'retro/archive-plan.md')
      if (!fs.existsSync(planAbs) || fs.statSync(planAbs).size === 0) {
        const reason = `retro/archive-plan.md 缺失或为空(task 有 ${check.total} 个 bootstrap resource,必须产出归档计划)`
        log.warn({ reason }, 'propose rejected (L2d: archive-plan missing)')
        return { ok: false, layer: 2, reason }
      }
    }
  }

  // Layer 3：LLM lint（默认关，接口预留）
  // TODO(wave2b/M2): 工厂 contentLint=true 时调用 LLM 校验
  log.debug({ targetState }, 'propose validation passed (L3 disabled)')

  return { ok: true }
}

/**
 * 简化版校验（不需要工厂 deliverables，只检查 evidence 里的制品路径是否存在）
 * 用于 human/system role 的 transition（如 human-complete）。
 */
export function validateEvidenceFiles(
  taskWorkdir: string,
  evidencePaths: string[],
  log: Logger
): ValidationResult {
  for (const relPath of evidencePaths) {
    const absPath = path.join(taskWorkdir, relPath)
    if (!fs.existsSync(absPath)) {
      const reason = `evidence file not found: ${relPath}`
      log.warn({ reason }, 'evidence validation failed')
      return { ok: false, layer: 1, reason }
    }
  }
  return { ok: true }
}
