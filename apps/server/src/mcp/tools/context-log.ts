/**
 * 组 13: context_log —— at-hook 自动调用（chatroom-protocol spec）
 * 写 SQLite context_access_log 表。
 */

import { ContextLogInput } from '@agent-team/protocol'
import type { McpToolContext } from '../context.js'

export function registerContextLogTool(ctx: McpToolContext): void {
  ctx.mcpServer.tool(
    'context_log',
    'Log a context access event (called by at-hook, not by agents directly)',
    ContextLogInput.shape,
    async (args) => {
      const input = ContextLogInput.parse(args)

      ctx.db
        .prepare(
          `INSERT INTO context_access_log (task_id, agent_id, action, ref, ts)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(input.taskId, input.agentId, input.action, input.ref, input.ts)

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: true }) }],
      }
    }
  )
}
