/**
 * 组 15.3: spawn-agent.ts
 * agent 生命周期领域逻辑 —— spawn 流程。
 *
 * 分层纪律（bootstrap-notes #11）：
 *   - 不 import mcp / adapters / http / ws
 *   - fs/cli 操作通过依赖注入（SpawnDeps）传入
 *   - 参照 orchestrator EffectEmitter 解耦手法
 */

import type { AgentModelProfile, Factory } from '@agent-team/protocol'
import fs from 'node:fs'
import path from 'node:path'
import { newAgentId } from '../../util/id.js'

/** spawn 依赖接口（由 process 层注入真实实现）*/
export interface SpawnDeps {
  /** 初始化 workspace（建目录、软链、写配置）*/
  initWorkspace(opts: InitWorkspaceOpts): Promise<InitWorkspaceResult>
  /** 探针验证软链（返回 false 则 fallback copy）*/
  probeSymlinks(workspacePath: string, skills: string[]): Promise<{ ok: boolean }>
  /** fallback rsync copy skills */
  fallbackCopySkills(workspacePath: string, skills: string[], globalSkillsDir: string): void
  /** 启动 ACP bridge、创建 session，返回 sessionId */
  spawnCli(opts: CliSpawnOpts): Promise<string>
}

export interface InitWorkspaceOpts {
  taskWorkdir: string
  agentId: string
  factory: Factory
  displayName: string
  runtime?: AgentModelProfile
  mcpServers: MiniMcpServer[]
  globalSkillsDir?: string
}

export interface InitWorkspaceResult {
  workspacePath: string
  symlinkOk: boolean
}

/** stdio 形态 MCP server */
export interface MiniMcpServerStdio {
  type?: 'stdio'
  name: string
  command: string
  args: string[]
  env?: Record<string, string>
}

/** HTTP 形态 MCP server（chatroom-mcp 经 HTTP 暴露给 ACP bridge）*/
export interface MiniMcpServerHttp {
  type: 'http'
  name: string
  url: string
  headers: Array<{ name: string; value: string }>
}

/** SSE 形态 MCP server */
export interface MiniMcpServerSse {
  type: 'sse'
  name: string
  url: string
  headers: Array<{ name: string; value: string }>
}

/** MCP server 联合类型 */
export type MiniMcpServer = MiniMcpServerStdio | MiniMcpServerHttp | MiniMcpServerSse

export interface CliSpawnOpts {
  workspace: string
  additionalDirectories: string[]
  mcpServers: MiniMcpServer[]
  initialPrompt: string
  runtime?: AgentModelProfile
}

/** spawn 结果 */
export interface SpawnResult {
  agentId: string
  displayName: string
  workspacePath: string
  sessionId: string
  /** 是否使用了软链 fallback */
  symlinkFallback: boolean
  /** spawn 时实际使用的模型配置快照 */
  modelProfile?: AgentModelProfile
}

/**
 * 从工厂 namePool 抽签 displayName（无重复）。
 * usedNames：已被同 task 其他 agent 占用的名字。
 */
export function drawDisplayName(namePool: string[], usedNames: Set<string>): string {
  const available = namePool.filter((n) => !usedNames.has(n))
  if (available.length === 0) {
    // 池子用完，生成通用名（边缘 case）
    return `agent-${Date.now()}`
  }
  const idx = Math.floor(Math.random() * available.length)
  return available[idx]!
}

/**
 * agent spawn 主流程（10 步，agent-runtime spec）：
 *  1. 抽签 displayName
 *  2. 生成 agentId
 *  3. 初始化 workspace（建目录 + 软链 + 写配置）
 *  4. 探针验证软链
 *  5. fallback copy（若软链不可见）
 *  6. 组装 MCP server 列表（core + recommended + task-level）
 *  7. 启动 CLI adapter（ACP session）
 *  8. 返回 SpawnResult
 *
 * @param taskWorkdir  task 工作目录
 * @param factory      工厂定义
 * @param usedNames    已用名字集（本 task 内）
 * @param taskWorktree task worktree 绝对路径（additionalDirectories 传给 ACP）
 * @param extraMcps    task-level 注入（SeatSpec.mcpInjections）
 * @param initialPrompt 首轮 prompt
 * @param deps         注入的 fs/cli 操作
 * @param globalSkillsDir 覆盖全局 skills 目录（测试用）
 */
export async function spawnAgent(opts: {
  taskWorkdir: string
  factory: Factory
  usedNames: Set<string>
  taskWorktree: string
  extraMcps?: MiniMcpServer[]
  runtime?: AgentModelProfile
  initialPrompt: string
  deps: SpawnDeps
  globalSkillsDir?: string
  /**
   * 若 seat 上次的 agent 已记录 displayName,优先复用(防止 server 重启后
   * agent 换名)。usedNames 已包含该名字时仍允许复用 — 同 seat 接续 spawn
   * 不算"冲突"。
   */
  preferredDisplayName?: string
}): Promise<SpawnResult> {
  const { taskWorkdir, factory, usedNames, taskWorktree, extraMcps = [], initialPrompt, deps } = opts

  // 1. 复用 preferred 或抽签
  let displayName: string
  if (opts.preferredDisplayName && factory.defaultNamePool.includes(opts.preferredDisplayName)) {
    displayName = opts.preferredDisplayName
  } else {
    displayName = drawDisplayName(factory.defaultNamePool, usedNames)
  }
  usedNames.add(displayName)

  // 2. 生成 agentId
  const agentId = newAgentId(factory.name)

  // 3. 组装 MCP server 列表（core + recommended + task-level）
  const allMcps: MiniMcpServer[] = [
    ...factory.coreMcps,
    ...factory.recommendedMcps,
    ...extraMcps,
  ]

  // 4. 初始化 workspace
  const { workspacePath, symlinkOk } = await deps.initWorkspace({
    taskWorkdir,
    agentId,
    factory,
    displayName,
    runtime: opts.runtime,
    mcpServers: allMcps,
    globalSkillsDir: opts.globalSkillsDir,
  })

  // 5. 探针验证软链
  let finalSymlinkOk = symlinkOk
  if (symlinkOk && factory.recommendedSkills.length > 0) {
    const probeResult = await deps.probeSymlinks(workspacePath, factory.recommendedSkills)
    if (!probeResult.ok) {
      finalSymlinkOk = false
    }
  }

  // 6. fallback copy（若软链不可见）
  if (!finalSymlinkOk && factory.recommendedSkills.length > 0) {
    const globalSkillsDir =
      opts.globalSkillsDir ?? `${process.env['HOME'] ?? '~'}/.claude/skills`
    deps.fallbackCopySkills(workspacePath, factory.recommendedSkills, globalSkillsDir)
  }

  // 7. 启动 CLI adapter
  // Phase 4.1: 仅在 taskWorktree 非空(即 primary-worktree resource 已 ready)时注入。
  // 否则 agent 不获得任何空目录或 fake worktree 路径。
  const extraDirs = taskWorktree
    ? [taskWorktree, ...resolveWorktreeGitDirectories(taskWorktree)]
    : []
  const sessionId = await deps.spawnCli({
    workspace: workspacePath,
    additionalDirectories: Array.from(new Set([taskWorkdir, ...extraDirs])),
    mcpServers: allMcps,
    initialPrompt,
    runtime: opts.runtime,
  })

  return {
    agentId,
    displayName,
    workspacePath,
    sessionId,
    symlinkFallback: !finalSymlinkOk,
    modelProfile: opts.runtime,
  }
}

export function resolveWorktreeGitDirectories(taskWorktree: string): string[] {
  const dotGit = path.join(taskWorktree, '.git')
  if (!fs.existsSync(dotGit)) return []

  if (fs.statSync(dotGit).isDirectory()) return [dotGit]

  const gitFile = fs.readFileSync(dotGit, 'utf-8')
  const gitDirMatch = /^gitdir:\s*(.+)\s*$/m.exec(gitFile)
  if (!gitDirMatch) return []

  const gitDir = resolveMaybeRelative(taskWorktree, gitDirMatch[1]!)
  const dirs = [gitDir]
  const commonDirFile = path.join(gitDir, 'commondir')
  if (fs.existsSync(commonDirFile)) {
    const commonDir = fs.readFileSync(commonDirFile, 'utf-8').trim()
    if (commonDir) dirs.push(resolveMaybeRelative(gitDir, commonDir))
  }
  return dirs
}

function resolveMaybeRelative(fromDir: string, target: string): string {
  return path.normalize(path.isAbsolute(target) ? target : path.resolve(fromDir, target))
}
