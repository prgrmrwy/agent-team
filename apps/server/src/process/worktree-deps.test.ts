import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { initializePnpmWorktreeDeps } from './worktree-deps.js'

let tmp: string | null = null

afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  tmp = null
})

describe('initializePnpmWorktreeDeps', () => {
  it('reuses pnpm deps while rewriting workspace package links to the worktree', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-team-deps-'))
    const repo = path.join(tmp, 'repo')
    const wt = path.join(tmp, 'wt')
    fs.mkdirSync(path.join(repo, 'node_modules', '.pnpm', 'zod@1', 'node_modules', 'zod'), {
      recursive: true,
    })
    fs.mkdirSync(path.join(repo, 'apps', 'web', 'node_modules', '@agent-team'), {
      recursive: true,
    })
    fs.mkdirSync(path.join(repo, 'apps', 'web', 'node_modules', '@scope'), { recursive: true })
    fs.mkdirSync(path.join(repo, 'packages', 'protocol'), { recursive: true })
    fs.mkdirSync(path.join(wt, 'apps', 'web'), { recursive: true })
    fs.mkdirSync(path.join(wt, 'packages', 'protocol'), { recursive: true })
    fs.mkdirSync(path.join(wt, '.git', 'info'), { recursive: true })

    fs.symlinkSync(
      '../../../node_modules/.pnpm/zod@1/node_modules/zod',
      path.join(repo, 'apps', 'web', 'node_modules', 'zod'),
      'dir'
    )
    fs.symlinkSync(
      '../../../../packages/protocol',
      path.join(repo, 'apps', 'web', 'node_modules', '@agent-team', 'protocol'),
      'dir'
    )

    const result = initializePnpmWorktreeDeps({ repoRoot: repo, worktreeRoot: wt })

    expect(result.linkedRootNodeModules).toBe(true)
    expect(result.gitExcludeUpdated).toBe(true)
    expect(fs.readlinkSync(path.join(wt, 'node_modules'))).toBe(path.join(repo, 'node_modules'))
    expect(fs.readlinkSync(path.join(wt, 'apps', 'web', 'node_modules', 'zod'))).toBe(
      '../../../node_modules/.pnpm/zod@1/node_modules/zod'
    )
    expect(
      fs.readlinkSync(path.join(wt, 'apps', 'web', 'node_modules', '@agent-team', 'protocol'))
    ).toBe(path.join(wt, 'packages', 'protocol'))
    expect(fs.readFileSync(path.join(wt, '.git', 'info', 'exclude'), 'utf-8')).toContain(
      'apps/*/node_modules'
    )
  })

  it('skips when worktree node_modules already exists and respects gitdir file', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-team-deps-skip-'))
    const repo = path.join(tmp, 'repo')
    const wt = path.join(tmp, 'wt')
    const gitCommon = path.join(tmp, 'gitcommon', 'worktrees', 'wt')
    fs.mkdirSync(path.join(repo, 'node_modules'), { recursive: true })
    fs.mkdirSync(path.join(repo, 'apps', 'web', 'node_modules'), { recursive: true })
    fs.mkdirSync(path.join(wt, 'apps', 'web', 'node_modules'), { recursive: true })
    fs.mkdirSync(wt, { recursive: true })
    fs.mkdirSync(gitCommon, { recursive: true })
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${gitCommon}\n`)

    const result = initializePnpmWorktreeDeps({ repoRoot: repo, worktreeRoot: wt })

    expect(result.linkedPackageNodeModules).not.toContain(path.join('apps', 'web', 'node_modules'))
    expect(result.skipped.length).toBeGreaterThan(0)
    expect(result.gitExcludeUpdated).toBe(true)
    expect(fs.readFileSync(path.join(gitCommon, 'info', 'exclude'), 'utf-8')).toContain(
      'packages/*/node_modules'
    )
    expect(fs.readlinkSync(path.join(wt, 'node_modules'))).toBe(path.join(repo, 'node_modules'))
  })
})
