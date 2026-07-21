import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { initializePnpmWorktreeDeps } from '../worktree-deps.js'
import type {
  BootstrapProvider,
  BootstrapProviderContext,
  PrepareResult,
  ReleaseResult,
  StatusResult,
} from './types.js'
import type { TaskBootstrapResource } from '@agent-team/protocol'

/**
 * generic-pnpm provider: 在仓库 repoRoot 内
 *   1. 创建隔离分支 `task/<taskId>` (若已存在则复用)
 *   2. `git worktree add <taskWorkdir>/worktree task/<taskId>`
 *   3. 调用 initializePnpmWorktreeDeps 做 lean reuse
 *
 * mode='full' 时跳过 lean reuse,留给后续阶段自行 pnpm install。
 * release 默认保留 (D7) — 删 worktree 需 phase 5 二次校验,这里只回报 retained。
 */
export function createGenericPnpmProvider(): BootstrapProvider {
  return {
    id: 'generic-pnpm',
    async prepare(ctx) {
      const wtPath = worktreePathFor(ctx)
      const branch = branchFor(ctx)
      try {
        await ensureBranchAndWorktree(ctx.repoRoot, wtPath, branch)
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          summary: 'git worktree add failed',
        }
      }

      const summaryParts: string[] = [`worktree=${wtPath}`, `branch=${branch}`]
      if (ctx.mode !== 'full') {
        try {
          const deps = initializePnpmWorktreeDeps({ repoRoot: ctx.repoRoot, worktreeRoot: wtPath })
          summaryParts.push(
            `linked=${deps.linkedPackageNodeModules.length}`,
            `git-exclude=${deps.gitExcludeUpdated ? 'updated' : 'kept'}`,
          )
        } catch (err) {
          return {
            ok: false,
            path: wtPath,
            branch,
            error: err instanceof Error ? err.message : String(err),
            summary: 'lean dependency reuse failed',
          } as PrepareResult
        }
      } else {
        summaryParts.push('mode=full (skip lean reuse)')
      }

      return {
        ok: true,
        path: wtPath,
        branch,
        summary: summaryParts.join(' '),
      }
    },

    async status(_ctx, resource): Promise<StatusResult> {
      if (resource.status === 'ready' || resource.status === 'failed' || resource.status === 'creating') {
        return {
          status: resource.status,
          path: resource.path,
          branch: resource.branch,
          summary: resource.summary,
          error: resource.error,
        }
      }
      return { status: 'ready', path: resource.path, branch: resource.branch }
    },

    async release(ctx, resource): Promise<ReleaseResult> {
      const wt = resource.path
      const branchName = resource.branch ?? branchFor(ctx)
      // 无 path → 强制 retain(没什么可删)
      if (!wt) {
        return { terminalStatus: 'retained', summary: 'worktree retained (no path)' }
      }
      const policy = ctx.releasePolicy
      switch (policy) {
        case 'retain':
          return { terminalStatus: 'retained', summary: `worktree retained at ${wt}` }
        case 'prompt':
          return {
            terminalStatus: 'needs-review',
            summary: `policy=prompt → 等用户决定:retain or remove (worktree ${wt})`,
          }
        case 'archive': {
          // 给当前 branch 打 archive tag,保留 worktree(第一版不真删 — 安全)
          const err = await runGit(ctx.repoRoot, ['tag', `archive/${ctx.taskId}`, branchName]).then(
            () => null,
            (e: unknown) => (e instanceof Error ? e.message : String(e)),
          )
          if (err) {
            return {
              terminalStatus: 'needs-review',
              summary: 'archive 打 tag 失败,退到 needs-review',
              error: err,
            }
          }
          return {
            terminalStatus: 'archived',
            summary: `tag archive/${ctx.taskId} → ${branchName};worktree retained at ${wt}`,
          }
        }
        case 'remove-if-clean': {
          const dirty = await worktreeDirty(wt).catch(() => true)
          if (dirty) {
            return {
              terminalStatus: 'retained',
              summary: `worktree 有未提交改动,保留 ${wt} 待人工处理`,
            }
          }
          const err = await runGit(ctx.repoRoot, ['worktree', 'remove', '--force', wt]).then(
            () => null,
            (e: unknown) => (e instanceof Error ? e.message : String(e)),
          )
          if (err) {
            return {
              terminalStatus: 'retained',
              summary: `worktree remove 失败,保留 ${wt}`,
              error: err,
            }
          }
          return { terminalStatus: 'removed', summary: `worktree removed at ${wt}` }
        }
        default: {
          const _exhaust: never = policy
          void _exhaust
          return { terminalStatus: 'retained', summary: `unknown policy ${String(policy)}` }
        }
      }
    },
  }
}

function worktreePathFor(ctx: BootstrapProviderContext): string {
  return path.join(ctx.taskWorkdir, 'worktree')
}

function branchFor(ctx: BootstrapProviderContext): string {
  const explicit = ctx.options['branch']
  if (typeof explicit === 'string' && explicit.length > 0) return explicit
  return `task/${ctx.taskId}`
}

async function ensureBranchAndWorktree(
  repoRoot: string,
  worktreePath: string,
  branch: string,
): Promise<void> {
  if (fs.existsSync(path.join(worktreePath, '.git'))) {
    return
  }
  if (fs.existsSync(worktreePath)) {
    const entries = fs.readdirSync(worktreePath)
    if (entries.length > 0) {
      throw new Error(`worktree path ${worktreePath} is not empty`)
    }
    fs.rmdirSync(worktreePath)
  }
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true })

  const branchExists = await runGit(repoRoot, [
    'show-ref',
    '--verify',
    '--quiet',
    `refs/heads/${branch}`,
  ]).then(
    () => true,
    () => false,
  )

  const args = branchExists
    ? ['worktree', 'add', worktreePath, branch]
    : ['worktree', 'add', '-b', branch, worktreePath]

  await runGit(repoRoot, args)
}

async function worktreeDirty(wtPath: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const proc = spawn('git', ['status', '--porcelain'], { cwd: wtPath, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    proc.on('error', () => resolve(true)) // 出错保守认作 dirty
    proc.on('exit', () => resolve(stdout.trim().length > 0))
  })
}

async function runGit(cwd: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    proc.on('error', reject)
    proc.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`git ${args.join(' ')} exited ${code}: ${stderr.trim()}`))
    })
  })
}

export type { BootstrapProvider }
