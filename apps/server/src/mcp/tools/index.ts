/**
 * 统一注册 13 个 MCP 工具到 McpToolContext.mcpServer。
 * 工具 schema 来自 @agent-team/protocol McpTools 注册表（不重定义）。
 */

import type { McpToolContext } from '../context.js'
import { registerChatroomTools } from './chatroom.js'
import { registerArtifactTools } from './artifact.js'
import { registerSeatTools } from './seat.js'
import { registerTaskStateTools } from './task-state.js'
import { registerTaskWriteTool } from './task-write.js'
import { registerContextLogTool } from './context-log.js'
import { registerTaskResourceTools } from './task-resource.js'

export function registerAllTools(ctx: McpToolContext): void {
  registerChatroomTools(ctx)
  registerArtifactTools(ctx)
  registerSeatTools(ctx)
  registerTaskStateTools(ctx)
  registerTaskWriteTool(ctx)
  registerContextLogTool(ctx)
  registerTaskResourceTools(ctx)
}
