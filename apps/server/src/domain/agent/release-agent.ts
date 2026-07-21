/**
 * 组 15.4: release-agent.ts
 * agent 释放流程（S11 done/aborted 时调用）。
 *
 * 分层纪律：不 import mcp/adapters/http/ws，CLI kill 通过注入接口。
 */

export interface ReleaseDeps {
  /** kill ACP session（SIGTERM → 超时 → SIGKILL）*/
  killCli(sessionId: string): Promise<void>
  /** 归档 workspace（拷贝 factory.lock.yaml 到 retro/）*/
  archiveWorkspace(taskWorkdir: string, agentId: string): void
}

export interface ReleaseOpts {
  taskWorkdir: string
  agentId: string
  sessionId: string
  reason: 'done' | 'aborted'
  deps: ReleaseDeps
}

/**
 * 释放单个 agent。
 * 按 spec：SIGTERM → 归档 → workspace 不删（作为归档保留）。
 */
export async function releaseAgent(opts: ReleaseOpts): Promise<void> {
  const { taskWorkdir, agentId, sessionId, deps } = opts

  // 1. 发 SIGTERM（等待退出或超时 SIGKILL）
  await deps.killCli(sessionId)

  // 2. 归档（factory.lock.yaml → retro/agent-<id>-snapshot/）
  deps.archiveWorkspace(taskWorkdir, agentId)
}
