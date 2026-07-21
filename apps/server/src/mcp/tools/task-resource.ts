/**
 * task_resource_get — agents 查询 task bootstrap resources。
 *
 * 直接读 task DB `bootstrap_resources` 表，对应 TaskBootstrapResource schema。
 * 可选 resourceId 过滤；resource 不存在时返回空数组（agent 据此判断 worktree 未就绪）。
 */

import {
  TaskBootstrapResource,
  TaskResourceGetInput,
  type TaskBootstrapResource as TaskBootstrapResourceT,
} from '@agent-team/protocol'
import type { McpToolContext } from '../context.js'

export function registerTaskResourceTools(ctx: McpToolContext): void {
  ctx.mcpServer.tool(
    'task_resource_get',
    'Get bootstrap resources for a task (worktree status/path/branch/mode/provider)',
    TaskResourceGetInput.shape,
    async (args) => {
      const input = TaskResourceGetInput.parse(args)
      const rows = input.resourceId
        ? ctx.db
            .prepare(
              `SELECT * FROM bootstrap_resources WHERE task_id = ? AND id = ?`,
            )
            .all(input.taskId, input.resourceId)
        : ctx.db
            .prepare(
              `SELECT * FROM bootstrap_resources WHERE task_id = ? ORDER BY created_at`,
            )
            .all(input.taskId)

      const resources: TaskBootstrapResourceT[] = (rows as Record<string, unknown>[]).map(rowToResource)
      return ok({ resources })
    },
  )
}

function rowToResource(row: Record<string, unknown>): TaskBootstrapResourceT {
  return TaskBootstrapResource.parse({
    id: row['id'],
    taskId: row['task_id'],
    kind: row['kind'],
    status: row['status'],
    provider: row['provider'],
    mode: row['mode'] ?? undefined,
    path: row['path'] ?? undefined,
    branch: row['branch'] ?? undefined,
    baseRef: row['base_ref'] ?? undefined,
    summary: row['summary'] ?? undefined,
    error: row['error'] ?? undefined,
    attempts: row['attempts'] ?? 0,
    createdAt: row['created_at'],
    updatedAt: row['updated_at'],
  })
}

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] }
}
