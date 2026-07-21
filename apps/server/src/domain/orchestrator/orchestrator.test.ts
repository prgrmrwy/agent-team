/**
 * 组 12 单测：state-machine + permission + propose-handler + transition-effects
 * 每条 transition ≥1 happy + 1 reject（task-lifecycle spec 要求）
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { pino } from 'pino'
import {
  TRANSITION_TABLE,
  findTransition,
  isValidTransition,
  isAllowed,
  validTargets,
  activePhasesOf,
  driversForState,
} from './state-machine.js'
import { checkProposalPermission } from './permission.js'
import { validatePropose } from './propose-handler.js'
import { EffectEmitter, applyTransitionEffects } from './transition-effects.js'
import type { Factory } from '@agent-team/protocol'

const log = pino({ level: 'silent' })

// 工厂 fixture
const plannerFactory: Factory = {
  name: 'planner',
  version: 1,
  persona: 'test',
  systemPromptTemplate: 'hello',
  defaultNamePool: ['诸葛亮'],
  coreMcps: [{ name: 'chatroom-mcp', command: 'node', args: [] }],
  lifecycle: 'alwaysOn',
  recommendedSkills: [],
  recommendedCliTools: [],
  recommendedMcps: [],
  fallbackModelProfiles: [],
  defaultPermissions: { proposeTransitions: ['S1->S2', 'S11->done'] },
  workingHabits: [],
  deliverables: [],
}

const engineerFactory: Factory = {
  ...plannerFactory,
  name: 'engineer',
  defaultPermissions: { proposeTransitions: ["S6->S10'"] },
  deliverables: [],
}

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// ---- state-machine ----
describe('state-machine transition table', () => {
  it('TRANSITION_TABLE 覆盖所有 M1 transition', () => {
    const keys = TRANSITION_TABLE.map((t) => `${t.from}→${t.to}`)
    expect(keys).toContain('S0→S1')
    expect(keys).toContain('S1→S2')
    expect(keys).toContain('S2→S6')
    expect(keys).toContain("S6→S10'")
    expect(keys).toContain("S10'→S11")
    expect(keys).toContain('S11→done')
  })

  it('findTransition S1→S2 (happy)', () => {
    const t = findTransition('S1', 'S2')
    expect(t).toBeDefined()
    expect(t?.event).toBe('planner-propose-S2')
  })

  it('activePhasesOf 从 proposeTransitions 取 from 去重', () => {
    expect(activePhasesOf(['S6->S7', "S6->S10'"])).toEqual(['S6'])
    expect(activePhasesOf(['S7->S9', 'S7->S6', "S7->S10'"])).toEqual(['S7'])
    expect(activePhasesOf(['S1->S2', 'S11->done', 'releasing->done']).sort()).toEqual(
      ['S1', 'S11', 'releasing'].sort(),
    )
    expect(activePhasesOf(["S9->S10'", 'S9->S6'])).toEqual(['S9'])
    expect(activePhasesOf([])).toEqual([])
  })

  it('driversForState 反向解析活跃角色', () => {
    const factories = [
      { name: 'engineer', proposeTransitions: ['S6->S7', "S6->S10'"] },
      { name: 'qa', proposeTransitions: ['S7->S9', 'S7->S6', "S7->S10'"] },
      { name: 'ci', proposeTransitions: ["S9->S10'", 'S9->S6'] },
      { name: 'planner', proposeTransitions: ['S1->S2', 'S11->done', 'releasing->done'] },
    ]
    expect(driversForState('S6', factories)).toEqual(['engineer'])
    expect(driversForState('S7', factories)).toEqual(['qa'])
    expect(driversForState('S9', factories)).toEqual(['ci'])
    expect(driversForState('S1', factories)).toEqual(['planner'])
    expect(driversForState('S11', factories)).toEqual(['planner'])
    // S2 / S10' 无 agent driver(human/system 转移)
    expect(driversForState('S2', factories)).toEqual([])
    expect(driversForState("S10'", factories)).toEqual([])
  })

  it('findTransition S0→done (reject: 无该 transition)', () => {
    expect(findTransition('S0', 'done')).toBeUndefined()
  })

  it('isValidTransition S6→S10\' (happy)', () => {
    expect(isValidTransition('S6', "S10'")).toBe(true)
  })

  it('isValidTransition done→S0 (reject)', () => {
    expect(isValidTransition('done', 'S0')).toBe(false)
  })

  it('isAllowed planner S1→S2 (happy)', () => {
    expect(isAllowed('S1', 'S2', 'planner')).toBe(true)
  })

  it('isAllowed engineer S1→S2 (reject: engineer 不能做 S1→S2)', () => {
    expect(isAllowed('S1', 'S2', 'engineer')).toBe(false)
  })

  it('validTargets S1 返回 [S2]', () => {
    expect(validTargets('S1')).toEqual(['S2'])
  })

  // m2-qa-role: S7 transitions
  it('TRANSITION_TABLE 含 m2-qa-role 的 S7 三条转移', () => {
    const keys = TRANSITION_TABLE.map((t) => `${t.from}→${t.to}`)
    expect(keys).toContain('S6→S7') // engineer-propose-S7
    expect(keys).toContain("S7→S10'") // qa-propose-S10
    expect(keys).toContain('S7→S6') // qa-propose-repair
  })

  it("S7 的 validTargets 含 S10' / S6 / S9", () => {
    expect(validTargets('S7').sort()).toEqual(["S10'", 'S6', 'S9'].sort())
  })

  it("isAllowed engineer S6→S7 (happy) + qa S7→S10' / S7→S6 (happy)", () => {
    expect(isAllowed('S6', 'S7', 'engineer')).toBe(true)
    expect(isAllowed('S7', "S10'", 'qa')).toBe(true)
    expect(isAllowed('S7', 'S6', 'qa')).toBe(true)
  })

  it("isAllowed engineer S7→S10' (reject: 只有 qa 能从 S7 推进)", () => {
    expect(isAllowed('S7', "S10'", 'engineer')).toBe(false)
  })

  // m2-ci-factory: S9 transitions
  it('TRANSITION_TABLE 含 m2-ci-factory 的 S9 两条转移', () => {
    const keys = TRANSITION_TABLE.map((t) => `${t.from}→${t.to}`)
    expect(keys).toContain('S7→S9') // qa-propose-S9
    expect(keys).toContain("S9→S10'") // ci-propose-ready2merge
  })

  it("isAllowed qa S7→S9 / ci S9→S10' (happy) + engineer S7→S9 (reject)", () => {
    expect(isAllowed('S7', 'S9', 'qa')).toBe(true)
    expect(isAllowed('S9', "S10'", 'ci')).toBe(true)
    expect(isAllowed('S7', 'S9', 'engineer')).toBe(false)
    expect(isAllowed('S9', "S10'", 'qa')).toBe(false)
  })
})

// ---- permission ----
describe('permission checkProposalPermission', () => {
  it('planner S1→S2 with factory permission (happy)', () => {
    const result = checkProposalPermission('S1', 'S2', 'planner', plannerFactory)
    expect(result.ok).toBe(true)
  })

  it('engineer S1→S2 (reject: transition allowedBy 不含 engineer)', () => {
    const result = checkProposalPermission('S1', 'S2', 'engineer', engineerFactory)
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/permission denied/)
  })

  it('no valid transition (reject: S0→done)', () => {
    const result = checkProposalPermission('S0', 'done', 'planner', plannerFactory)
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/no valid transition/)
  })

  it('planner S11→done with factory permission (happy)', () => {
    const result = checkProposalPermission('S11', 'done', 'planner', plannerFactory)
    expect(result.ok).toBe(true)
  })

  it('engineer S6→S10\' with factory permission (happy)', () => {
    const result = checkProposalPermission('S6', "S10'", 'engineer', engineerFactory)
    expect(result.ok).toBe(true)
  })

  it('human S10\'→S11 no factory check (happy)', () => {
    const result = checkProposalPermission("S10'", 'S11', 'human')
    expect(result.ok).toBe(true)
  })
})

// ---- propose-handler ----
describe('propose-handler validatePropose', () => {
  it('deliverables 文件存在且 section 完整 (happy)', async () => {
    const factory: Factory = {
      ...plannerFactory,
      deliverables: ['plan/task-plan.md'],
    }
    fs.mkdirSync(path.join(tmpDir, 'plan'), { recursive: true })
    fs.writeFileSync(
      path.join(tmpDir, 'plan/task-plan.md'),
      '## seatPlan\n\ncontent\n\n## 验收锚点\n\nok\n',
      'utf-8'
    )

    const result = await validatePropose(
      tmpDir,
      'S2',
      factory,
      { artifacts: [] },
      log
    )
    expect(result.ok).toBe(true)
  })

  it('deliverables 文件缺失 (reject L1)', async () => {
    const factory: Factory = {
      ...plannerFactory,
      deliverables: ['plan/task-plan.md'],
    }
    const result = await validatePropose(
      tmpDir,
      'S2',
      factory,
      { artifacts: [] },
      log
    )
    expect(result.ok).toBe(false)
    expect(result.layer).toBe(1)
    expect(result.reason).toMatch(/not found/)
  })

  it('文件存在但缺 section (reject L2)', async () => {
    const factory: Factory = {
      ...plannerFactory,
      deliverables: ['plan/task-plan.md'],
    }
    fs.mkdirSync(path.join(tmpDir, 'plan'), { recursive: true })
    fs.writeFileSync(
      path.join(tmpDir, 'plan/task-plan.md'),
      '# some content without required sections',
      'utf-8'
    )
    const result = await validatePropose(
      tmpDir,
      'S2',
      factory,
      { artifacts: [] },
      log
    )
    expect(result.ok).toBe(false)
    expect(result.layer).toBe(2)
    expect(result.reason).toMatch(/missing required section/)
  })

  it('无 deliverables 配置直接通过 (happy)', async () => {
    const factory: Factory = { ...plannerFactory, deliverables: [] }
    const result = await validatePropose(tmpDir, 'S6', factory, { artifacts: [] }, log)
    expect(result.ok).toBe(true)
  })

  // m2-qa-role: L2b qa report gate
  describe('L2b: S7→S10\' 要求 qa/verification_report.md 无 FAIL', () => {
    const qaFactory: Factory = {
      ...plannerFactory,
      name: 'qa' as const,
      defaultPermissions: { proposeTransitions: ["S7->S10'", 'S7->S6'] },
      deliverables: ['qa/verification_report.md'],
    }

    it("缺 qa 报告 → reject (L1 或 L2b 都算 gate 失败)", async () => {
      const result = await validatePropose(
        tmpDir,
        "S10'",
        qaFactory,
        { artifacts: [] },
        log,
        'S7'
      )
      expect(result.ok).toBe(false)
      // L1 先触发(deliverable 文件缺失)就够,L2b 是 L1 通过后的兜底;两层都正确拒绝
      expect([1, 2]).toContain(result.layer)
    })

    it("L2b 独立触发: deliverables 空但 currentState=S7 还是要求 qa 报告", async () => {
      // L1 跳过(deliverables 空,无文件可查),但 L2b 仍校验 qa/verification_report.md 存在
      const factoryNoDeliverables: Factory = { ...qaFactory, deliverables: [] }
      const result = await validatePropose(
        tmpDir,
        "S10'",
        factoryNoDeliverables,
        { artifacts: [] },
        log,
        'S7'
      )
      expect(result.ok).toBe(false)
      expect(result.layer).toBe(2)
      expect(result.reason).toMatch(/qa\/verification_report\.md 不存在/)
    })

    it("qa 报告含 FAIL 结论 → reject (L2b)", async () => {
      fs.mkdirSync(path.join(tmpDir, 'qa'), { recursive: true })
      fs.writeFileSync(
        path.join(tmpDir, 'qa/verification_report.md'),
        '## A1\n结论: PASS\n证据: ok\n## A2\n结论: FAIL\n现象: x\n## 最终结论: FAIL\n',
        'utf-8'
      )
      const result = await validatePropose(
        tmpDir,
        "S10'",
        qaFactory,
        { artifacts: ['qa/verification_report.md'] },
        log,
        'S7'
      )
      expect(result.ok).toBe(false)
      expect(result.layer).toBe(2)
      expect(result.reason).toMatch(/含 FAIL 结论/)
    })

    it('qa 报告全 PASS → accept', async () => {
      fs.mkdirSync(path.join(tmpDir, 'qa'), { recursive: true })
      fs.writeFileSync(
        path.join(tmpDir, 'qa/verification_report.md'),
        '## A1\n结论: PASS\n证据: ok\n## A2\n结论: PASS\n证据: ok\n## 最终结论: PASS\n',
        'utf-8'
      )
      const result = await validatePropose(
        tmpDir,
        "S10'",
        qaFactory,
        { artifacts: ['qa/verification_report.md'] },
        log,
        'S7'
      )
      expect(result.ok).toBe(true)
    })
  })

  // m2-ci-factory: L2c ci report gate
  describe("L2c: S9→S10' 要求 ci/ci_report.md 含 `ready2merge: true`", () => {
    const ciFactory: Factory = {
      ...plannerFactory,
      name: 'ci' as const,
      defaultPermissions: { proposeTransitions: ["S9->S10'"] },
      deliverables: ['ci/ci_report.md'],
    }

    it('缺 ci 报告 → reject (L1 或 L2c 都算 gate 失败)', async () => {
      const result = await validatePropose(
        tmpDir,
        "S10'",
        ciFactory,
        { artifacts: [] },
        log,
        'S9'
      )
      expect(result.ok).toBe(false)
      expect([1, 2]).toContain(result.layer)
    })

    it('ci 报告无 ready2merge 标记 → reject (L2c)', async () => {
      fs.mkdirSync(path.join(tmpDir, 'ci'), { recursive: true })
      fs.writeFileSync(
        path.join(tmpDir, 'ci/ci_report.md'),
        '# CI Report\n## MR\nlink: stub\n## CI\nstatus: PASS\n## ready2merge\nfalse\n',
        'utf-8'
      )
      const result = await validatePropose(
        tmpDir,
        "S10'",
        ciFactory,
        { artifacts: ['ci/ci_report.md'] },
        log,
        'S9'
      )
      expect(result.ok).toBe(false)
      expect(result.layer).toBe(2)
      expect(result.reason).toMatch(/ready2merge/)
    })

    it('ci 报告含 `ready2merge: true` → accept', async () => {
      fs.mkdirSync(path.join(tmpDir, 'ci'), { recursive: true })
      fs.writeFileSync(
        path.join(tmpDir, 'ci/ci_report.md'),
        '# CI Report\n## MR\nlink: stub\n## CI\nstatus: PASS\n## ready2merge\ntrue\n',
        'utf-8'
      )
      const result = await validatePropose(
        tmpDir,
        "S10'",
        ciFactory,
        { artifacts: ['ci/ci_report.md'] },
        log,
        'S9'
      )
      expect(result.ok).toBe(true)
    })
  })

  describe('multi-version evidence(增量验收支持)', () => {
    const engineerFactory: Factory = {
      ...plannerFactory,
      name: 'engineer',
      deliverables: ['eng/test-report-1.md', 'eng/commits-1.txt'],
    }
    const qaFactory: Factory = {
      ...plannerFactory,
      name: 'qa',
      deliverables: ['qa/verification_report-1.md'],
    }

    it('带版本号的 eng/test-report-2.md L2 走 stripVersionSuffix → schema 通过', async () => {
      const factory: Factory = {
        ...plannerFactory,
        name: 'engineer',
        deliverables: ['eng/test-report-2.md', 'eng/commits-2.txt'],
      }
      fs.mkdirSync(path.join(tmpDir, 'eng'), { recursive: true })
      fs.writeFileSync(
        path.join(tmpDir, 'eng/test-report-2.md'),
        '# Test Report\n## 结果\nall pass\n',
        'utf-8'
      )
      fs.writeFileSync(path.join(tmpDir, 'eng/commits-2.txt'), 'abc123\n', 'utf-8')
      const result = await validatePropose(
        tmpDir,
        'S7',
        factory,
        { artifacts: ['eng/test-report-2.md', 'eng/commits-2.txt'] },
        log,
        'S6'
      )
      expect(result.ok).toBe(true)
    })

    it('S7→S10\' L2b 优先用 evidence 里的 qa/verification_report-3.md', async () => {
      const factory: Factory = {
        ...plannerFactory,
        name: 'qa',
        deliverables: ['qa/verification_report-3.md'],
      }
      fs.mkdirSync(path.join(tmpDir, 'qa'), { recursive: true })
      fs.writeFileSync(
        path.join(tmpDir, 'qa/verification_report-3.md'),
        '## 最终结论: PASS\n',
        'utf-8'
      )
      const result = await validatePropose(
        tmpDir,
        "S10'",
        factory,
        { artifacts: ['qa/verification_report-3.md'] },
        log,
        'S7'
      )
      expect(result.ok).toBe(true)
    })

    it('S7→S10\' L2b evidence 没列时 fallback findLatestVersionedFile', async () => {
      const factory: Factory = {
        ...plannerFactory,
        name: 'qa',
        deliverables: [],
      }
      fs.mkdirSync(path.join(tmpDir, 'qa'), { recursive: true })
      fs.writeFileSync(
        path.join(tmpDir, 'qa/verification_report-1.md'),
        '## 最终结论: PASS\n',
        'utf-8'
      )
      fs.writeFileSync(
        path.join(tmpDir, 'qa/verification_report-5.md'),
        '## 最终结论: PASS\n',
        'utf-8'
      )
      const result = await validatePropose(
        tmpDir,
        "S10'",
        factory,
        { artifacts: [] }, // 空 evidence,fallback 找最新
        log,
        'S7'
      )
      // 应该挑 verification_report-5.md(max n),不报 not found
      expect(result.ok).toBe(true)
    })

    it('S7→S10\' L2b 最新 qa report 含 FAIL → reject', async () => {
      const factory: Factory = {
        ...plannerFactory,
        name: 'qa',
        deliverables: ['qa/verification_report-2.md'],
      }
      fs.mkdirSync(path.join(tmpDir, 'qa'), { recursive: true })
      fs.writeFileSync(
        path.join(tmpDir, 'qa/verification_report-2.md'),
        '## 最终结论: FAIL\n',
        'utf-8'
      )
      const result = await validatePropose(
        tmpDir,
        "S10'",
        factory,
        { artifacts: ['qa/verification_report-2.md'] },
        log,
        'S7'
      )
      expect(result.ok).toBe(false)
      expect(result.reason).toMatch(/FAIL/)
    })
  })
})

// ---- transition-effects ----
describe('transition-effects applyTransitionEffects', () => {
  // phase-driven-orchestration:applyTransitionEffects 不再 emit recruit / retro-start
  // (spawn/wake 移到 process 层 phase-change dispatcher 据 driversForState 处理)。
  // domain 层只剩 phase-change + notify(S10') + release(done/aborted)。
  it('S1→S2 只广播 phase-change(不再 emit recruit)', () => {
    const emitter = new EffectEmitter()
    const phaseChanges: unknown[] = []
    const recruits: unknown[] = []
    emitter.on('phase-change', (e) => phaseChanges.push(e))
    emitter.on('recruit', (e) => recruits.push(e))

    applyTransitionEffects('task-1', 'S1', 'S2', 'planner', emitter, ['seat-1'])
    expect(phaseChanges.length).toBe(1)
    expect(recruits.length).toBe(0)
  })

  it('S6→S10\' 广播 phase-change + notify (happy)', () => {
    const emitter = new EffectEmitter()
    const notifies: unknown[] = []
    emitter.on('notify', (e) => notifies.push(e))

    applyTransitionEffects('task-1', 'S6', "S10'", 'engineer', emitter)
    expect(notifies.length).toBe(1)
  })

  it('S7→S9 只广播 phase-change(不再 emit recruit;ci spawn 由 process dispatcher 懒 spawn)', () => {
    const emitter = new EffectEmitter()
    const phaseChanges: unknown[] = []
    const recruits: unknown[] = []
    emitter.on('phase-change', (e) => phaseChanges.push(e))
    emitter.on('recruit', (e) => recruits.push(e))

    applyTransitionEffects('task-1', 'S7', 'S9', 'qa', emitter)
    expect(phaseChanges.length).toBe(1)
    expect(recruits.length).toBe(0)
  })

  it('S11→done 广播 release (happy)', () => {
    const emitter = new EffectEmitter()
    const releases: unknown[] = []
    emitter.on('release', (e) => releases.push(e))

    applyTransitionEffects('task-1', 'S11', 'done', 'planner', emitter)
    expect(releases.length).toBe(1)
  })

  it('S0→S1 只广播 phase-change (reject: 没有 recruit/notify/release)', () => {
    const emitter = new EffectEmitter()
    const all: unknown[] = []
    emitter.on('phase-change', (e) => all.push({ type: 'phase-change', ...e }))
    emitter.on('recruit', () => all.push({ type: 'recruit' }))
    emitter.on('notify', () => all.push({ type: 'notify' }))
    emitter.on('release', () => all.push({ type: 'release' }))

    applyTransitionEffects('task-1', 'S0', 'S1', 'human', emitter)
    const typed = all as { type: string }[]
    expect(typed.filter((e) => e.type === 'phase-change').length).toBe(1)
    expect(typed.filter((e) => e.type !== 'phase-change').length).toBe(0)
  })
})

// ---- task-bootstrap-lifecycle phase 5: releasing state ----
describe('phase 5: releasing transitions', () => {
  it("TRANSITION_TABLE 含 S10'→releasing 与 releasing→done", () => {
    const keys = TRANSITION_TABLE.map((t) => `${t.from}→${t.to}`)
    expect(keys).toContain("S10'→releasing")
    expect(keys).toContain('releasing→done')
  })

  it("isAllowed human S10'→releasing (happy) + planner releasing→done (happy)", () => {
    expect(isAllowed("S10'", 'releasing', 'human')).toBe(true)
    expect(isAllowed('releasing', 'done', 'planner')).toBe(true)
  })

  it('isAllowed engineer releasing→done (reject)', () => {
    expect(isAllowed('releasing', 'done', 'engineer')).toBe(false)
  })

  it("S10'→releasing 不触发 release (agents 仍在线;planner 唤醒由 process dispatcher 据 driver 处理)", () => {
    const emitter = new EffectEmitter()
    const events: string[] = []
    emitter.on('release', () => events.push('release'))
    const phaseChanges: unknown[] = []
    emitter.on('phase-change', (e) => phaseChanges.push(e))
    applyTransitionEffects('task-1', "S10'", 'releasing', 'human', emitter)
    // phase-driven:不再 emit retro-start;只广播 phase-change,planner 作为 releasing driver
    // 由 process 层 dispatcher 唤醒。release 仍不触发(agents 在线)。
    expect(phaseChanges.length).toBe(1)
    expect(events).not.toContain('release')
  })

  it('releasing→done 才触发 release (agents 终被释放)', () => {
    const emitter = new EffectEmitter()
    const events: string[] = []
    emitter.on('release', () => events.push('release'))
    applyTransitionEffects('task-1', 'releasing', 'done', 'planner', emitter)
    expect(events).toContain('release')
  })
})

describe('phase 5: validatePropose releasing→done gate', () => {
  const plannerWithRetroPerm: Factory = {
    ...plannerFactory,
    defaultPermissions: { proposeTransitions: ['releasing->done', 'S11->done'] },
    deliverables: ['retro/retrospective.md', 'retro/archive-plan.md'],
  }

  it('有 resources 但缺 archive-plan 被拒(L2d)', async () => {
    fs.mkdirSync(path.join(tmpDir, 'retro'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, 'retro/retrospective.md'), '## 任务概要\n\nok\n')
    // no archive-plan; task 声称有 1 个 terminal resource
    const result = await validatePropose(
      tmpDir,
      'done',
      plannerWithRetroPerm,
      { artifacts: ['retro/retrospective.md'] },
      log,
      'releasing',
      { taskId: 't1', resourceTerminalChecker: () => ({ allTerminal: true, nonTerminalIds: [], total: 1 }) },
    )
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/archive-plan\.md/)
  })

  it('bootstrap resources 仍 non-terminal 被拒(L2d)', async () => {
    fs.mkdirSync(path.join(tmpDir, 'retro'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, 'retro/retrospective.md'), '## 任务概要\n\nok\n')
    fs.writeFileSync(
      path.join(tmpDir, 'retro/archive-plan.md'),
      '## resources\n\n- primary-worktree: retain\n',
    )
    const result = await validatePropose(
      tmpDir,
      'done',
      plannerWithRetroPerm,
      { artifacts: ['retro/retrospective.md', 'retro/archive-plan.md'] },
      log,
      'releasing',
      {
        taskId: 't1',
        resourceTerminalChecker: () => ({
          allTerminal: false,
          nonTerminalIds: ['primary-worktree'],
          total: 1,
        }),
      },
    )
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/primary-worktree/)
  })

  it('retro + archive-plan + 所有 resources 终态 → 通过', async () => {
    fs.mkdirSync(path.join(tmpDir, 'retro'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, 'retro/retrospective.md'), '## 任务概要\n\nok\n')
    fs.writeFileSync(
      path.join(tmpDir, 'retro/archive-plan.md'),
      '## resources\n\n- primary-worktree: retained (provider=generic-pnpm)\n',
    )
    const result = await validatePropose(
      tmpDir,
      'done',
      plannerWithRetroPerm,
      { artifacts: ['retro/retrospective.md', 'retro/archive-plan.md'] },
      log,
      'releasing',
      { taskId: 't1', resourceTerminalChecker: () => ({ allTerminal: true, nonTerminalIds: [], total: 1 }) },
    )
    expect(result.ok).toBe(true)
  })

  it('无 bootstrap resources(total=0) 时 archive-plan 可省略 → 通过', async () => {
    fs.mkdirSync(path.join(tmpDir, 'retro'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, 'retro/retrospective.md'), '## 任务概要\n\nok\n')
    // 不写 archive-plan.md
    const result = await validatePropose(
      tmpDir,
      'done',
      plannerWithRetroPerm,
      { artifacts: ['retro/retrospective.md'] },
      log,
      'releasing',
      { taskId: 't1', resourceTerminalChecker: () => ({ allTerminal: true, nonTerminalIds: [], total: 0 }) },
    )
    expect(result.ok).toBe(true)
  })

  it('needs-review 视为终态(不阻塞 done)', async () => {
    fs.mkdirSync(path.join(tmpDir, 'retro'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, 'retro/retrospective.md'), '## 任务概要\n\nok\n')
    fs.writeFileSync(
      path.join(tmpDir, 'retro/archive-plan.md'),
      '## resources\n\n- primary-worktree: needs-review (sw 默认保守)\n',
    )
    // needs-review 在 DB 里写入 terminal_status='needs-review',checker 返回 allTerminal=true
    const result = await validatePropose(
      tmpDir,
      'done',
      plannerWithRetroPerm,
      { artifacts: ['retro/retrospective.md', 'retro/archive-plan.md'] },
      log,
      'releasing',
      { taskId: 't1', resourceTerminalChecker: () => ({ allTerminal: true, nonTerminalIds: [], total: 1 }) },
    )
    expect(result.ok).toBe(true)
  })
})

// keep `vi` reference for future expansion
void vi
