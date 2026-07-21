/**
 * 组 10 单测：factory-loader + factory-repo
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { pino } from 'pino'
import yaml from 'js-yaml'
import { loadFactories, getFactory, _clearRegistry } from './factory-loader.js'
import { saveFactory, listFactoryVersions, rollbackFactory } from './factory-repo.js'
import { openDb, runMigrations } from '../../db/client.js'

const log = pino({ level: 'silent' })
const defaultsDir = path.join(import.meta.dirname ?? __dirname, 'defaults')

// 有效工厂 fixture
const validPlanner = {
  name: 'planner' as const,
  version: 1,
  persona: 'test persona',
  systemPromptTemplate: 'hello {{displayName}}',
  defaultNamePool: ['诸葛亮', '张良'],
  coreMcps: [{ name: 'chatroom-mcp', command: 'node', args: [] as string[] }],
  lifecycle: 'alwaysOn' as const,
  recommendedSkills: [] as string[],
  recommendedCliTools: [] as string[],
  recommendedMcps: [],
  fallbackModelProfiles: [],
  defaultPermissions: { proposeTransitions: ['S1->S2'] },
  workingHabits: [] as string[],
  deliverables: ['plan/task-plan.md'],
}

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-test-'))
  _clearRegistry()
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  _clearRegistry()
})

describe('factory-loader', () => {
  it('加载有效 planner.yaml 校验通过', () => {
    fs.writeFileSync(path.join(tmpDir, 'planner.yaml'), yaml.dump(validPlanner), 'utf-8')
    loadFactories(tmpDir, log)
    const f = getFactory('planner')
    expect(f).toBeDefined()
    expect(f?.name).toBe('planner')
    expect(f?.defaultNamePool).toContain('诸葛亮')
  })

  it('加载有效 engineer.yaml 校验通过', () => {
    const eng = { ...validPlanner, name: 'engineer' as const, defaultPermissions: { proposeTransitions: ["S6->S10'"] } }
    fs.writeFileSync(path.join(tmpDir, 'engineer.yaml'), yaml.dump(eng), 'utf-8')
    loadFactories(tmpDir, log)
    const f = getFactory('engineer')
    expect(f).toBeDefined()
    expect(f?.name).toBe('engineer')
  })

  // ci 工厂加载 + recommendedSkills 含 pm / rebase / deploy
  it('加载有效 ci.yaml(含 pm / rebase / deploy skill)校验通过', () => {
    const ci = {
      ...validPlanner,
      name: 'ci' as const,
      defaultPermissions: { proposeTransitions: ["S9->S10'"] },
      recommendedSkills: ['pm', 'rebase', 'deploy'],
      defaultNamePool: ['萧何', '管仲', '张居正', '王安石'],
      deliverables: ['ci/ci_report.md'],
    }
    fs.writeFileSync(path.join(tmpDir, 'ci.yaml'), yaml.dump(ci), 'utf-8')
    loadFactories(tmpDir, log)
    const f = getFactory('ci')
    expect(f).toBeDefined()
    expect(f?.name).toBe('ci')
    expect(f?.recommendedSkills).toContain('pm')
    expect(f?.recommendedSkills).toContain('rebase')
    expect(f?.recommendedSkills).toContain('deploy')
    expect(f?.defaultPermissions.proposeTransitions).toContain("S9->S10'")
    expect(f?.deliverables).toContain('ci/ci_report.md')
  })

  it('缺少必填字段 defaultNamePool 时不注册工厂', () => {
    const bad: Record<string, unknown> = { ...validPlanner }
    delete bad['defaultNamePool']
    fs.writeFileSync(path.join(tmpDir, 'planner.yaml'), yaml.dump(bad), 'utf-8')
    loadFactories(tmpDir, log)
    expect(getFactory('planner')).toBeUndefined()
  })

  it('目录不存在时 warn 但不抛错', () => {
    expect(() => loadFactories('/nonexistent/dir', log)).not.toThrow()
  })

  it('备份文件（.bak）不被加载', () => {
    // 写一个 .bak 文件
    fs.writeFileSync(path.join(tmpDir, 'planner.v1.yaml.bak'), yaml.dump(validPlanner), 'utf-8')
    loadFactories(tmpDir, log)
    expect(getFactory('planner')).toBeUndefined()
  })

  it('默认 factories 声明 primary/fallback model profile', () => {
    loadFactories(defaultsDir, log)

    // 临时切到 codex-sdk 作主(claude 额度) — preferred ↔ fallback swap
    expect(getFactory('planner')?.preferredModelProfile).toEqual({
      provider: 'codex-sdk',
      model: 'gpt-5.5',
      reasoningEffort: 'medium',
    })
    expect(getFactory('planner')?.fallbackModelProfiles).toEqual([
      { provider: 'claude-acp', model: 'claude-opus-4.7', reasoningEffort: 'medium' },
    ])

    for (const name of ['engineer', 'qa', 'ci'] as const) {
      expect(getFactory(name)?.preferredModelProfile).toEqual({
        provider: 'codex-sdk',
        model: 'gpt-5.4',
      })
      expect(getFactory(name)?.fallbackModelProfiles).toEqual([
        { provider: 'claude-acp', model: 'claude-sonnet-4.6' },
      ])
    }
  })

  it('默认 engineer factory 明确 QA FAIL 后必须继续回修', () => {
    loadFactories(defaultsDir, log)
    const engineer = getFactory('engineer')
    expect(engineer?.systemPromptTemplate).toContain('QA FAIL 回修纪律')
    expect(engineer?.systemPromptTemplate).toContain('不得只回复"收到/等待/下一步应继续"后停下')
    expect(engineer?.workingHabits.join('\n')).toContain('QA FAIL')
  })
})

describe('factory-repo', () => {
  function makeDb() {
    const dbPath = path.join(tmpDir, 'index.db')
    const migrationsDir = path.join(
      import.meta.dirname ?? __dirname,
      '../../db/migrations-index'
    )
    const db = openDb(dbPath, log)
    runMigrations(db, migrationsDir, log)
    return db
  }

  it('saveFactory 备份旧 yaml 并写新版本', () => {
    const db = makeDb()
    // 先写原始 yaml
    fs.writeFileSync(path.join(tmpDir, 'planner.yaml'), yaml.dump(validPlanner), 'utf-8')

    const saved = saveFactory(db, tmpDir, validPlanner, log)
    expect(saved.version).toBe(2)

    // 备份文件应存在
    expect(fs.existsSync(path.join(tmpDir, 'planner.v1.yaml.bak'))).toBe(true)

    // 新 yaml 存在且 version=2
    const newContent = yaml.load(fs.readFileSync(path.join(tmpDir, 'planner.yaml'), 'utf-8')) as {
      version: number
    }
    expect(newContent.version).toBe(2)
  })

  it('listFactoryVersions 返回历史记录', () => {
    const db = makeDb()
    saveFactory(db, tmpDir, validPlanner, log)
    const rows = listFactoryVersions(db, 'planner')
    expect(rows.length).toBeGreaterThanOrEqual(1)
    expect(rows[0]?.name).toBe('planner')
  })

  it('rollbackFactory 从 .bak 恢复并版本递增', () => {
    const db = makeDb()
    fs.writeFileSync(path.join(tmpDir, 'planner.yaml'), yaml.dump(validPlanner), 'utf-8')
    saveFactory(db, tmpDir, validPlanner, log) // v1 → v2，bak: v1
    const restored = rollbackFactory(db, tmpDir, 'planner', 1, log)
    expect(restored.version).toBeGreaterThan(1)
  })
})
