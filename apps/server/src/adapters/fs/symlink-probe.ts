/**
 * 组 15.2: symlink-probe.ts
 * 探针验证 skill 软链可见性（agent-runtime spec "软链 vs Copy 实测策略"）。
 *
 * 实现：直接检查软链是否能跟踪到真实目录（fs.statSync follow symlinks）。
 * 不执行 `claude --list-skills`（需要启动进程，在 M1 测试环境过重）。
 * 验收时架构师可替换为真实 claude CLI 探针。
 */

import fs from 'node:fs'
import path from 'node:path'

export interface ProbeResult {
  ok: boolean
  /** 不可见的 skill 列表（软链不可跟踪）*/
  failedSkills: string[]
}

/**
 * 探针验证：检查 workspace 内的 skills 目录中每个 skill 软链是否可跟踪。
 * 返回 ok=false 表示需要 fallback copy。
 */
export function probeSymlinks(workspacePath: string, skillNames: string[]): ProbeResult {
  if (skillNames.length === 0) {
    return { ok: true, failedSkills: [] }
  }

  const skillsDir = path.join(workspacePath, '.claude', 'skills')
  const failedSkills: string[] = []

  for (const skillName of skillNames) {
    const skillPath = path.join(skillsDir, skillName)

    // 软链目标不存在（lstat 不跟踪软链）
    if (!fs.existsSync(skillPath)) {
      failedSkills.push(skillName)
      continue
    }

    try {
      // stat 跟踪软链，如果软链指向不存在的目录则抛出
      fs.statSync(skillPath)
    } catch {
      failedSkills.push(skillName)
    }
  }

  return {
    ok: failedSkills.length === 0,
    failedSkills,
  }
}

/**
 * 检查 workspace 内的 mcp.json 是否存在且可解析。
 */
export function probeMcpConfig(workspacePath: string): boolean {
  const mcpPath = path.join(workspacePath, 'mcp.json')
  if (!fs.existsSync(mcpPath)) return false

  try {
    const content = fs.readFileSync(mcpPath, 'utf-8')
    JSON.parse(content)
    return true
  } catch {
    return false
  }
}
