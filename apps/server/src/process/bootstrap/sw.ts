import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type {
  BootstrapProvider,
  BootstrapProviderContext,
  PrepareResult,
  ReleaseResult,
  StatusResult,
} from './types.js'
import type { TaskBootstrapResource } from '@agent-team/protocol'

/**
 * sw / Nexus adapter — Phase 2.4 仅做 subprocess 包装,不复制 sw 核心逻辑 (D1 + open question 2)。
 * 调用 `~/.claude/skills/sw/scripts/start.sh`,解析 stdout 中
 *   SW_WORKTREE=<absolute path>
 *   SW_BRANCH=<branch>  (可选)
 *
 * 缺少 SW_WORKTREE 或脚本非零 exit 视为 failed。
 * release 默认返回 needs-review — sw 脚本有 clean.sh,但默认保守由人工 review。
 */
export interface SwProviderOptions {
  /** override 测试用的脚本路径;否则用 ~/.claude/skills/sw/scripts/start.sh */
  startScript?: string
  cleanScript?: string
}

export function createSwProvider(opts: SwProviderOptions = {}): BootstrapProvider {
  const startScript = opts.startScript ?? defaultStartScript()
  const cleanScript = opts.cleanScript ?? defaultCleanScript()

  return {
    id: 'sw',
    async prepare(ctx): Promise<PrepareResult> {
      if (!fs.existsSync(startScript)) {
        return {
          ok: false,
          error: `sw start script missing: ${startScript}`,
          summary: 'sw skill not installed',
        }
      }
      const args = buildArgs(ctx)
      try {
        const { exitCode, combined } = await runBash(
          startScript,
          args,
          ctx.repoRoot,
          { ...process.env, AGENT_TEAM_TASK_ID: ctx.taskId },
        )
        const parsed = parseSwOutput(combined)
        if (exitCode !== 0 || !parsed.path) {
          // 优先用 sw.sh 的真实尾巴(如 "[sw] error: not a Nexus checkout")作 error,
          // 这样 UI 一眼能看到为啥失败;协议层 generic 提示放 summary。
          const realTail = tail(combined, 4) || `sw start exited with code ${exitCode}`
          return {
            ok: false,
            error: realTail,
            summary: parsed.path
              ? `sw start exited ${exitCode}(详见 error)`
              : 'sw start 未输出 SW_WORKTREE=<path> — 多半 sw 仅适用于 Nexus 仓库,改用 generic-pnpm',
          }
        }
        return {
          ok: true,
          path: parsed.path,
          branch: parsed.branch,
          baseRef: parsed.baseRef,
          summary: tail(combined, 4),
        }
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          summary: 'sw start.sh threw',
        }
      }
    },

    async status(_ctx, resource): Promise<StatusResult> {
      // sw 启动同步完成 — 这里只回显当前 resource 状态,避免每次轮询都 fork bash。
      return {
        status: resource.status === 'ready' || resource.status === 'failed'
          ? resource.status
          : 'creating',
        path: resource.path,
        branch: resource.branch,
        summary: resource.summary,
        error: resource.error,
      }
    },

    async release(ctx, resource): Promise<ReleaseResult> {
      const policy = ctx.releasePolicy
      if (policy === 'retain') {
        return {
          terminalStatus: 'retained',
          summary: resource.path ? `sw worktree retained at ${resource.path}` : 'sw worktree retained',
        }
      }
      // sw 第一版没自动 clean / archive,所有非 retain 一律 needs-review,
      // 让 planner 在 archive-plan 中写"建议人工 sw clean.sh"
      const cleanAvailable = cleanScript && fs.existsSync(cleanScript)
      const note =
        policy === 'archive'
          ? 'sw provider 未实现 archive — 请人工 sw archive/clean.sh'
          : policy === 'prompt'
            ? 'policy=prompt → 等用户决定;sw clean 需人工触发'
            : cleanAvailable
              ? 'sw 未自动 clean — needs human review (sw clean.sh)'
              : 'sw clean.sh not found — manual review required'
      return {
        terminalStatus: 'needs-review',
        summary: resource.path ? `${resource.path}: ${note}` : note,
      }
    },
  }
}

function defaultStartScript(): string {
  // sw scripts 真正路径取自 SKILL.md (~/.claude/skills/sw/SKILL.md 引用的脚本),
  // 但 SKILL.md 里写的是 zy-hub 绝对路径;此处优先用 ~/.claude/skills/sw 目录,
  // 找不到时再回退到 SKILL.md 同时给出的绝对路径环境变量 SW_SCRIPTS_DIR。
  const fromEnv = process.env['SW_SCRIPTS_DIR']
  if (fromEnv) return path.join(fromEnv, 'start.sh')
  return path.join(os.homedir(), '.claude', 'skills', 'sw', 'scripts', 'start.sh')
}

function defaultCleanScript(): string {
  const fromEnv = process.env['SW_SCRIPTS_DIR']
  if (fromEnv) return path.join(fromEnv, 'clean.sh')
  return path.join(os.homedir(), '.claude', 'skills', 'sw', 'scripts', 'clean.sh')
}

function buildArgs(ctx: BootstrapProviderContext): string[] {
  const args: string[] = []
  const branchBase = ctx.options['branchBase']
  if (typeof branchBase === 'string' && branchBase.length > 0) args.push(branchBase)
  const description = ctx.options['description']
  if (typeof description === 'string' && description.length > 0) args.push(description)
  return args
}

interface ParsedSw {
  path?: string
  branch?: string
  baseRef?: string
}

export function parseSwOutput(out: string): ParsedSw {
  const result: ParsedSw = {}
  for (const line of out.split(/\r?\n/)) {
    const trimmed = line.trim()
    const wt = trimmed.match(/^SW_WORKTREE=(.+)$/)
    if (wt) result.path = wt[1]!.trim()
    const br = trimmed.match(/^SW_BRANCH=(.+)$/)
    if (br) result.branch = br[1]!.trim()
    const base = trimmed.match(/^SW_BASE=(.+)$/)
    if (base) result.baseRef = base[1]!.trim()
  }
  return result
}

async function runBash(
  script: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ exitCode: number; combined: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn('bash', [script, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let combined = ''
    proc.stdout.on('data', (chunk: Buffer) => {
      combined += chunk.toString()
    })
    proc.stderr.on('data', (chunk: Buffer) => {
      combined += chunk.toString()
    })
    proc.on('error', reject)
    proc.on('exit', (code) => resolve({ exitCode: code ?? -1, combined }))
  })
}

function tail(text: string, lines: number): string {
  const arr = text.split(/\r?\n/).filter((l) => l.length > 0)
  return arr.slice(-lines).join('\n')
}

export type { BootstrapProvider, TaskBootstrapResource }
