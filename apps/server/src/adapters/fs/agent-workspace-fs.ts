/**
 * 组 15.1: agent-workspace-fs.ts
 * 建 <task>/agents/<id>/ + 软链 skills（ln -s）+ 失败 fallback copy
 * + 写 mcp.json / .claude/settings.json / factory.lock.yaml（工厂快照）
 *
 * agent-runtime spec：
 *   - 软链优先，探针验证后 fallback copy
 *   - workspace 内 .claude/settings.json 是唯一可信来源（CVE-2025-59536）
 *   - factory.lock.yaml 快照在 spawn 时写入
 */

import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { AgentModelProfile, Factory } from '@agent-team/protocol'
import yaml from 'js-yaml'
import type { McpServerDecl } from '../cli/cli-adapter.js'

export interface WorkspaceInitOpts {
  taskWorkdir: string
  agentId: string
  factory: Factory
  displayName: string
  /** spawn 时实际使用的模型配置快照 */
  runtime?: AgentModelProfile
  /** 注入的 MCP servers（core + recommended + task-level）*/
  mcpServers: McpServerDecl[]
  /** 全局 skills 目录，默认 ~/.claude/skills */
  globalSkillsDir?: string
  /** 项目内 skills 目录，默认向上查找 .agents/skills */
  projectSkillsDir?: string
}

export interface WorkspaceInitResult {
  /** workspace 绝对路径 */
  workspacePath: string
  /** skill 软链是否成功（false 则已 fallback rsync）*/
  symlinkOk: boolean
}

interface AgentSettingsOptions {
  agentId: string
  taskId?: string
  mcpServers: Record<string, unknown>
  atHookBin?: string
  token?: string
  port?: string
}

/**
 * 初始化 agent workspace。
 * 幂等：如已存在则跳过已完成的步骤。
 */
export async function initAgentWorkspace(opts: WorkspaceInitOpts): Promise<WorkspaceInitResult> {
  const { taskWorkdir, agentId, factory, displayName, mcpServers } = opts

  const skillRoots = resolveSkillRoots(opts)

  const workspacePath = path.join(taskWorkdir, 'agents', agentId)
  const claudeDir = path.join(workspacePath, '.claude')
  const claudeSkillsDir = path.join(claudeDir, 'skills')
  const agentsSkillsDir = path.join(workspacePath, '.agents', 'skills')

  // 1. 建目录
  fs.mkdirSync(claudeSkillsDir, { recursive: true })
  fs.mkdirSync(agentsSkillsDir, { recursive: true })

  // 2. skills 软链（优先软链，失败 fallback copy）
  let symlinkOk = true

  const skillsToInstall = Array.from(new Set(factory.recommendedSkills))
  symlinkOk = installSkills(skillsToInstall, skillRoots, claudeSkillsDir) && symlinkOk
  symlinkOk = installSkills(skillsToInstall, skillRoots, agentsSkillsDir) && symlinkOk

  // 3. 写 mcp.json（Claude Code 的 MCP 配置，显式路径锁定 CVE-2025-59536）
  // 支持 stdio / http / sse 三种形态
  const mcpServersObj: Record<string, unknown> = {}
  for (const s of mcpServers) {
    if (s.type === 'http') {
      mcpServersObj[s.name] = { type: 'http', url: s.url }
    } else if (s.type === 'sse') {
      mcpServersObj[s.name] = { type: 'sse', url: s.url }
    } else {
      // stdio（type 可能未定义）
      const entry: Record<string, unknown> = { command: s.command, args: s.args }
      if (s.env) entry['env'] = s.env
      mcpServersObj[s.name] = entry
    }
  }
  const mcpJson = { mcpServers: mcpServersObj }
  fs.writeFileSync(path.join(workspacePath, 'mcp.json'), JSON.stringify(mcpJson, null, 2), 'utf-8')

  // 4. 写 .claude/settings.json（workspace 内唯一可信来源，CVE-2025-59536）
  const settings = createAgentSettings({
    agentId,
    taskId: process.env.TASK_ID,
    mcpServers: mcpServersObj,
    token: process.env.AGENT_TEAM_TOKEN,
    port: process.env.PORT,
  })
  fs.writeFileSync(
    path.join(claudeDir, 'settings.json'),
    JSON.stringify(settings, null, 2),
    'utf-8',
  )

  // 5. 写 factory.lock.yaml（spawn 快照）
  const lockSnapshot = {
    lockedAt: new Date().toISOString(),
    displayName,
    modelProfile: opts.runtime,
    factory: {
      name: factory.name,
      version: factory.version,
      persona: factory.persona,
      systemPromptTemplate: factory.systemPromptTemplate,
      coreMcps: factory.coreMcps,
      lifecycle: factory.lifecycle,
      recommendedSkills: factory.recommendedSkills,
      recommendedCliTools: factory.recommendedCliTools,
      recommendedMcps: factory.recommendedMcps,
      defaultPermissions: factory.defaultPermissions,
      workingHabits: factory.workingHabits,
      deliverables: factory.deliverables,
    },
  }
  fs.writeFileSync(path.join(workspacePath, 'factory.lock.yaml'), yaml.dump(lockSnapshot), 'utf-8')

  // 6. 创建 notes.md 占位（私有草稿）
  const notesPath = path.join(workspacePath, 'notes.md')
  if (!fs.existsSync(notesPath)) {
    fs.writeFileSync(notesPath, `# ${displayName} 的工作笔记\n\n`, 'utf-8')
  }

  return { workspacePath, symlinkOk }
}

/**
 * fallback：删除已建的软链，改用 rsync -a 拷贝所有 skill。
 * 仅在探针验证失败后调用。
 */
export function fallbackCopySkills(
  workspacePath: string,
  recommendedSkills: string[],
  globalSkillsDir: string,
  log: { warn: (msg: string) => void },
): void {
  const skillsDir = path.join(workspacePath, '.claude', 'skills')
  const skillRoots = { project: findExistingProjectSkillsDir(), global: globalSkillsDir }
  log.warn('WARN: symlink not followed, fell back to copy')

  for (const skillName of recommendedSkills) {
    const src = findSkillSource(skillName, skillRoots)
    const dest = path.join(skillsDir, skillName)

    // 删除软链（若存在）
    try {
      if (fs.existsSync(dest) && fs.lstatSync(dest).isSymbolicLink()) {
        fs.unlinkSync(dest)
      }
    } catch {
      // ignore
    }

    if (!src) continue

    try {
      execSync(`rsync -a "${src}/" "${dest}/"`, { stdio: 'ignore' })
    } catch {
      log.warn(`rsync failed for skill: ${skillName}`)
    }
  }
}

function resolveSkillRoots(opts: WorkspaceInitOpts): { project: string | null; global: string } {
  return {
    project: opts.projectSkillsDir ?? findExistingProjectSkillsDir(),
    global: opts.globalSkillsDir ?? path.join(process.env['HOME'] ?? '~', '.claude', 'skills'),
  }
}

function findExistingProjectSkillsDir(): string | null {
  const candidates = [
    process.env['AGENT_TEAM_PROJECT_SKILLS_DIR'],
    path.resolve(process.cwd(), '.agents/skills'),
    path.resolve(process.cwd(), '../../.agents/skills'),
    path.resolve(import.meta.dirname, '../../../../../.agents/skills'),
  ].filter((candidate): candidate is string => Boolean(candidate))

  return candidates.find((dir) => fs.existsSync(dir)) ?? null
}

function findSkillSource(
  skillName: string,
  roots: { project: string | null; global: string },
): string | null {
  const candidates = [
    roots.project ? path.join(roots.project, skillName) : null,
    path.join(roots.global, skillName),
  ].filter((candidate): candidate is string => Boolean(candidate))

  return candidates.find((candidate) => fs.existsSync(path.join(candidate, 'SKILL.md'))) ?? null
}

function copySkill(src: string, dest: string): void {
  fs.rmSync(dest, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.cpSync(src, dest, { recursive: true })
}

function installSkills(
  skillNames: string[],
  skillRoots: { project: string | null; global: string },
  targetDir: string,
): boolean {
  let symlinkOk = true
  for (const skillName of skillNames) {
    const source = findSkillSource(skillName, skillRoots)
    const targetLink = path.join(targetDir, skillName)

    if (fs.existsSync(targetLink)) continue
    if (!source) continue

    try {
      fs.symlinkSync(source, targetLink)
    } catch {
      copySkill(source, targetLink)
    }
  }
  return symlinkOk
}

/**
 * 归档 workspace 到 retro/（task done 或 aborted 时调用）。
 * workspace 目录保留，仅在 retro/ 下建快照链接。
 */
export function archiveAgentWorkspace(taskWorkdir: string, agentId: string): void {
  const retroDir = path.join(taskWorkdir, 'retro', `agent-${agentId}-snapshot`)
  const workspacePath = path.join(taskWorkdir, 'agents', agentId)

  if (!fs.existsSync(workspacePath)) return

  // retro 目录已存在则跳过
  if (fs.existsSync(retroDir)) return

  fs.mkdirSync(path.join(taskWorkdir, 'retro'), { recursive: true })

  // 拷贝 factory.lock.yaml 到 retro（轻量归档，不移动整个 workspace）
  const lockSrc = path.join(workspacePath, 'factory.lock.yaml')
  if (fs.existsSync(lockSrc)) {
    fs.mkdirSync(retroDir, { recursive: true })
    fs.copyFileSync(lockSrc, path.join(retroDir, 'factory.lock.yaml'))
  }
}

export function createAgentSettings(opts: AgentSettingsOptions): Record<string, unknown> {
  const settings: Record<string, unknown> = {
    // 只列出显式注入的 MCP，不继承任何 worktree 内的 settings
    mcpServers: opts.mcpServers,
  }

  if (!opts.taskId || !opts.token) return settings

  const atHookBin = opts.atHookBin ?? resolveAtHookBin()
  if (!fs.existsSync(atHookBin)) return settings

  const baseCommand = [
    shellQuote(atHookBin),
    '--task-id',
    shellQuote(opts.taskId),
    '--agent-id',
    shellQuote(opts.agentId),
    '--port',
    shellQuote(opts.port ?? '3001'),
    '--token',
    shellQuote(opts.token),
  ].join(' ')

  settings['hooks'] = {
    PreToolUse: [
      {
        matcher: '*',
        hooks: [{ type: 'command', command: `${baseCommand} --phase pre` }],
      },
    ],
    PostToolUse: [
      {
        matcher: '*',
        hooks: [{ type: 'command', command: `${baseCommand} --phase post` }],
      },
    ],
  }

  return settings
}

function resolveAtHookBin(): string {
  if (process.env.AT_HOOK_BIN) return process.env.AT_HOOK_BIN

  const fallback = path.resolve(process.cwd(), '../../tools/at-hook/bin.mjs')
  const candidates = [
    fallback,
    path.resolve(process.cwd(), 'tools/at-hook/bin.mjs'),
    path.resolve(import.meta.dirname, '../../../../tools/at-hook/bin.mjs'),
    path.resolve(import.meta.dirname, '../../../tools/at-hook/bin.mjs'),
  ]

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? fallback
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}
