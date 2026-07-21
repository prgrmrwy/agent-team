import type { Message } from '@agent-team/protocol'
import type { McpToolContext } from '../context.js'

export const HUMAN_CONFIRMATION_PREFIX = '⚠ 等待人类确认:'

export function isHumanConfirmationRequest(ctx: McpToolContext, msg: Message): boolean {
  return (
    msg.type === 'system-event' &&
    msg.content.trim().startsWith(HUMAN_CONFIRMATION_PREFIX) &&
    ctx.getRoleByAgentId(msg.sender) === 'planner'
  )
}

export function plannerBlockedByHumanConfirmation(
  ctx: McpToolContext,
  callerRole: string,
): boolean {
  return callerRole === 'planner' && (ctx.isHumanConfirmationPending?.() ?? false)
}

export function humanConfirmationBlockReason(action: string): string {
  return `waiting for human confirmation; planner cannot ${action} until a human replies`
}
