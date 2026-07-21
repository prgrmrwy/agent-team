/**
 * Phase 4.3: pure decision for engineer/qa/ci spawn gate based on primary
 * worktree resource status. Extracted from task-process-entry for testability.
 *
 * - null → ok (no bootstrap resource; provider=none case, agent has no worktree)
 * - 'ready' → ok
 * - 'failed' → fail (caller surfaces error + retry hint)
 * - anything else (creating + terminal post-release) → wait (poll again, bounded by timeout)
 */
export type WorktreeGateDecision = 'ok' | 'wait' | 'fail'

export function classifyWorktreeGate(status: string | null): WorktreeGateDecision {
  if (status === null) return 'ok'
  if (status === 'ready') return 'ok'
  if (status === 'failed') return 'fail'
  return 'wait'
}
