/**
 * 组 13: task_write —— FIFO 串行 + 角色目录校验（chatroom-protocol spec + design.md D16）
 *
 * 角色权限（M1）：
 *   planner → plan/ + retro/
 *   engineer → eng/
 *   qa → qa/
 *
 * FIFO 实现：per-task 写队列（Promise chain），保证并发请求串行执行。
 *
 * Caller 身份：从 extra.sessionId → getAgentIdByMcpSession → getRoleByAgentId 解析，
 * 替换旧的 inferCallerRole() 目录推断做法。
 */

import fs from 'node:fs'
import path from 'node:path'
import { TaskWriteInput } from '@agent-team/protocol'
import type { McpToolContext } from '../context.js'
import {
  humanConfirmationBlockReason,
  plannerBlockedByHumanConfirmation,
} from './human-confirmation-gate.js'

/** 角色 → 允许写的一级目录 */
const ROLE_DIRS: Record<string, string[]> = {
  // D5: planner 可写 openspec/ 下的 OpenSpec planning artifacts (planning home in task mgmt dir)
  planner: ['plan', 'retro', 'openspec'],
  engineer: ['eng'],
  qa: ['qa'],
  ci: ['ci'], // m2-ci-factory: ci 写 ci/ci_report.md + ci/ci-issues-{n}.md
}

// 子路径白名单：第一段命中后，要求第二段在此列表中（仅当 key 在表里时校验）
const ROLE_SUBPATH_WHITELIST: Record<string, string[]> = {
  // openspec/ 下只允许 changes/ 与 specs/ (specs 用于 archive sync 后的主库)
  openspec: ['changes', 'specs'],
}

/** FIFO 队列（per-task 全局 Promise chain）*/
const writeQueues = new Map<string, Promise<void>>()

function enqueueWrite(taskId: string, fn: () => Promise<void>): Promise<void> {
  const tail = writeQueues.get(taskId) ?? Promise.resolve()
  const next = tail.then(fn).catch(() => {
    // 不让单次失败断链
  })
  writeQueues.set(taskId, next)
  return next
}

/**
 * 从 extra.sessionId 推断 caller agentId，再从 registry 拿 role。
 * fallback：如果无法识别（测试环境或未注册 session），根据目标目录推断角色。
 * 此 fallback 保持测试兼容性；真实环境下 sessionId 始终存在。
 */
function resolveCallerRole(
  ctx: McpToolContext,
  extra: { sessionId?: string },
  targetDir: string,
): string {
  // stateless:优先 ctx.callerAgentId(URL 路径身份);回退旧 session 反查(单测/legacy)
  const agentId =
    ctx.callerAgentId ?? (extra.sessionId ? ctx.getAgentIdByMcpSession(extra.sessionId) : undefined)
  if (agentId) {
    const role = ctx.getRoleByAgentId(agentId)
    if (role) return role
  }
  // fallback：根据目标目录推断（测试环境 / 未注册 session）
  for (const [role, dirs] of Object.entries(ROLE_DIRS)) {
    if (dirs.includes(targetDir)) return role
  }
  return 'unknown'
}

export function registerTaskWriteTool(ctx: McpToolContext): void {
  ctx.mcpServer.tool(
    'task_write',
    'Write a file in the task artifact directories (role-checked, FIFO-serialized)',
    TaskWriteInput.shape,
    async (args, extra) => {
      const input = TaskWriteInput.parse(args)
      const { path: relPath, content, overwrite } = input

      // 校验路径不越界
      const absPath = path.resolve(ctx.taskWorkdir, relPath)
      if (!absPath.startsWith(ctx.taskWorkdir + path.sep) && absPath !== ctx.taskWorkdir) {
        return reject('path must be within task workdir')
      }

      // 禁止写系统文件
      const forbidden = ['agents', 'chatroom.jsonl', 'state.json', 'task.db']
      const firstSegment = relPath.split('/')[0] ?? ''
      if (forbidden.includes(firstSegment)) {
        return reject(`cannot write to protected path: ${firstSegment}`)
      }

      // 角色权限校验（从 HTTP MCP session → agentId → role，fallback 目录推断）
      const callerRole = resolveCallerRole(ctx, extra, firstSegment)
      const allowedDirs = ROLE_DIRS[callerRole] ?? []
      if (plannerBlockedByHumanConfirmation(ctx, callerRole)) {
        return reject(humanConfirmationBlockReason(`write ${firstSegment}/ artifacts`))
      }
      if (!allowedDirs.includes(firstSegment)) {
        return reject(
          `permission denied: ${callerRole} cannot write to ${firstSegment}/ (allowed: ${allowedDirs.join(', ')})`,
        )
      }
      const subWhitelist = ROLE_SUBPATH_WHITELIST[firstSegment]
      if (subWhitelist) {
        const secondSegment = relPath.split('/')[1] ?? ''
        if (!subWhitelist.includes(secondSegment)) {
          return reject(
            `permission denied: writes under ${firstSegment}/ are restricted to ${subWhitelist
              .map((s) => `${s}/`)
              .join(', ')} (got ${firstSegment}/${secondSegment || '<root>'})`,
          )
        }
      }

      // FIFO 串行写入
      let bytesWritten = 0
      let writeError: string | undefined

      await enqueueWrite(ctx.taskId, async () => {
        const dir = path.dirname(absPath)
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true })
        }

        if (!overwrite && fs.existsSync(absPath)) {
          writeError = `file already exists: ${relPath} (set overwrite=true to overwrite)`
          return
        }

        fs.writeFileSync(absPath, content, 'utf-8')
        bytesWritten = Buffer.byteLength(content, 'utf-8')
      })

      if (writeError) return reject(writeError)

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ success: true, bytesWritten }),
          },
        ],
      }
    },
  )
}

function reject(reason: string) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ success: false, reason }),
      },
    ],
  }
}
