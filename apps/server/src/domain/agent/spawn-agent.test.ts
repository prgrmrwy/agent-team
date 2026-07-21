import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Factory } from '@agent-team/protocol'
import {
  resolveWorktreeGitDirectories,
  spawnAgent,
  type CliSpawnOpts,
  type SpawnDeps,
} from './spawn-agent.js'

let tmp: string | null = null

afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  tmp = null
})

describe('resolveWorktreeGitDirectories', () => {
  it('includes linked-worktree gitdir and commondir for sandbox write access', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-team-gitdirs-'))
    const repoGit = path.join(tmp, 'repo', '.git')
    const worktree = path.join(tmp, 'task', 'worktree')
    const linkedGitDir = path.join(repoGit, 'worktrees', 'worktree')
    fs.mkdirSync(linkedGitDir, { recursive: true })
    fs.mkdirSync(worktree, { recursive: true })
    fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${linkedGitDir}\n`)
    fs.writeFileSync(path.join(linkedGitDir, 'commondir'), '../..')

    expect(resolveWorktreeGitDirectories(worktree)).toEqual([linkedGitDir, repoGit])
  })
})

// Phase 4.1/4.5: additionalDirectories should derive worktree from ready resource only.
describe('spawnAgent additionalDirectories (Phase 4.1)', () => {
  function makeDeps(captured: { spawn?: CliSpawnOpts }): SpawnDeps {
    return {
      initWorkspace: async (opts) => ({
        workspacePath: path.join(opts.taskWorkdir, opts.agentId),
        symlinkOk: true,
      }),
      probeSymlinks: async () => ({ ok: true }),
      fallbackCopySkills: () => {},
      spawnCli: async (opts) => {
        captured.spawn = opts
        return 'session-1'
      },
    }
  }

  const factory: Factory = {
    name: 'engineer',
    version: 1,
    defaultNamePool: ['Alpha'],
    coreMcps: [],
    recommendedMcps: [],
    recommendedSkills: [],
    systemPromptTemplate: '',
    deliverables: [],
    workingHabits: { defaultRecruitFactories: [] },
  } as unknown as Factory

  it('includes worktree path + gitdir when ready resource path is provided', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-agent-ready-'))
    const taskWorkdir = path.join(tmp, 'task')
    const repoGit = path.join(tmp, 'repo', '.git')
    const worktree = path.join(tmp, 'wt')
    const linkedGitDir = path.join(repoGit, 'worktrees', 'wt')
    fs.mkdirSync(taskWorkdir, { recursive: true })
    fs.mkdirSync(linkedGitDir, { recursive: true })
    fs.mkdirSync(worktree, { recursive: true })
    fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${linkedGitDir}\n`)
    fs.writeFileSync(path.join(linkedGitDir, 'commondir'), '../..')

    const captured: { spawn?: CliSpawnOpts } = {}
    await spawnAgent({
      taskWorkdir,
      factory,
      usedNames: new Set(),
      taskWorktree: worktree,
      initialPrompt: 'p',
      deps: makeDeps(captured),
    })
    expect(captured.spawn?.additionalDirectories).toEqual(
      expect.arrayContaining([taskWorkdir, worktree, linkedGitDir, repoGit]),
    )
  })

  it('omits worktree entry entirely when taskWorktree is empty (not ready)', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-agent-notready-'))
    const taskWorkdir = path.join(tmp, 'task')
    fs.mkdirSync(taskWorkdir, { recursive: true })

    const captured: { spawn?: CliSpawnOpts } = {}
    await spawnAgent({
      taskWorkdir,
      factory,
      usedNames: new Set(),
      taskWorktree: '',
      initialPrompt: 'p',
      deps: makeDeps(captured),
    })
    expect(captured.spawn?.additionalDirectories).toEqual([taskWorkdir])
  })
})
