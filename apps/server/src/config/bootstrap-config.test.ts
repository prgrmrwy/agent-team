import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { _resetConfigForTest } from './index.js'
import {
  discoverDefaultProvider,
  readProjectBootstrapConfig,
  resolveBootstrapConfig,
  saveProjectBootstrapConfig,
  projectBootstrapConfigPath,
} from './bootstrap-config.js'

function tmp(prefix: string): string {
  const d = path.join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  fs.mkdirSync(d, { recursive: true })
  return d
}

describe('bootstrap-config', () => {
  let dataHome: string

  beforeEach(() => {
    dataHome = tmp('agent-team-bootstrap')
    process.env['DATA_HOME'] = dataHome
    process.env['AGENT_TEAM_TOKEN'] = 'test-token'
    _resetConfigForTest()
  })

  afterEach(() => {
    fs.rmSync(dataHome, { recursive: true, force: true })
    delete process.env['DATA_HOME']
    delete process.env['AGENT_TEAM_TOKEN']
    _resetConfigForTest()
  })

  it('returns null when no config file exists', () => {
    expect(readProjectBootstrapConfig('proj-x')).toBeNull()
  })

  it('save + read round trip', () => {
    saveProjectBootstrapConfig('proj-x', {
      provider: 'sw',
      mode: 'lean',
      release: 'remove-if-clean',
      options: { baseRef: 'main' },
    })
    const file = projectBootstrapConfigPath('proj-x')
    expect(fs.existsSync(file)).toBe(true)
    const loaded = readProjectBootstrapConfig('proj-x')
    expect(loaded).toMatchObject({ provider: 'sw', mode: 'lean' })
    expect(loaded?.options).toEqual({ baseRef: 'main' })
  })

  it('resolveBootstrapConfig prefers explicit override', () => {
    saveProjectBootstrapConfig('proj-x', {
      provider: 'sw',
      mode: 'lean',
      release: 'remove-if-clean',
      options: {},
    })
    const out = resolveBootstrapConfig('proj-x', {
      provider: 'none',
      release: 'retain',
      options: {},
    })
    expect(out.provider).toBe('none')
  })

  it('resolveBootstrapConfig falls back to safe default', () => {
    const out = resolveBootstrapConfig('proj-without-config')
    expect(out.provider).toBe('generic-pnpm')
    expect(out.mode).toBe('lean')
  })

  it('discoverDefaultProvider detects sw skill', () => {
    const root = tmp('repo')
    const swDir = path.join(root, '.agents/skills/sw')
    fs.mkdirSync(swDir, { recursive: true })
    fs.writeFileSync(path.join(swDir, 'SKILL.md'), '---\nname: sw\n---\n')
    const r = discoverDefaultProvider(root)
    expect(r.provider).toBe('sw')
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('discoverDefaultProvider detects pnpm project', () => {
    const root = tmp('repo')
    fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n')
    const r = discoverDefaultProvider(root)
    expect(r.provider).toBe('generic-pnpm')
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('discoverDefaultProvider returns none when nothing detected', () => {
    const root = tmp('repo')
    const r = discoverDefaultProvider(root)
    expect(r.provider).toBe('none')
    fs.rmSync(root, { recursive: true, force: true })
  })
})
