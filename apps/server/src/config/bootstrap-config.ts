import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import {
  TaskBootstrapConfig,
  type BootstrapProvider,
  type TaskBootstrapConfig as TaskBootstrapConfigT,
} from '@agent-team/protocol'
import { getConfig } from './index.js'
import type { Logger } from '../util/logger.js'

/**
 * 项目级 bootstrap 默认配置:存放在
 *   ~/.agent-team/projects/<projectId>/bootstrap.yaml
 *
 * 首次启动时调用 discoverDefaultProvider 扫描项目 skill 目录,
 * 根据是否存在 `sw` / pnpm 工程推断 provider,但不自动落盘;
 * 由前端选择并通过 saveProjectBootstrapConfig 写回。
 *
 * (task-bootstrap-lifecycle 1.7 / D3 / Open Question 1)
 */

const SAFE_DEFAULT: TaskBootstrapConfigT = {
  provider: 'generic-pnpm',
  mode: 'lean',
  release: 'remove-if-clean',
  options: {},
}

export function projectBootstrapConfigPath(projectId: string): string {
  const { dataHome } = getConfig()
  return path.join(dataHome, 'projects', projectId, 'bootstrap.yaml')
}

export function readProjectBootstrapConfig(
  projectId: string,
  log?: Logger,
): TaskBootstrapConfigT | null {
  const file = projectBootstrapConfigPath(projectId)
  if (!fs.existsSync(file)) return null
  try {
    const raw = fs.readFileSync(file, 'utf-8')
    const parsed = yaml.load(raw)
    return TaskBootstrapConfig.parse(parsed)
  } catch (err) {
    log?.warn({ err, file }, 'invalid project bootstrap.yaml — falling back to discovery')
    return null
  }
}

export function saveProjectBootstrapConfig(
  projectId: string,
  config: TaskBootstrapConfigT,
  log?: Logger,
): void {
  const validated = TaskBootstrapConfig.parse(config)
  const file = projectBootstrapConfigPath(projectId)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, yaml.dump(validated), 'utf-8')
  log?.info({ file, provider: validated.provider }, 'project bootstrap config saved')
}

/**
 * 用项目级配置 → 安全默认 的顺序解析最终 bootstrap config。
 * task 创建路由调用,never throw。
 */
export function resolveBootstrapConfig(
  projectId: string,
  override?: TaskBootstrapConfigT,
  log?: Logger,
): TaskBootstrapConfigT {
  if (override) return TaskBootstrapConfig.parse(override)
  const project = readProjectBootstrapConfig(projectId, log)
  if (project) return project
  return SAFE_DEFAULT
}

/**
 * 首次启动时扫描项目 skill 目录,根据存在的 skill 入口推断推荐 provider。
 * - 找到 `sw` skill → 推荐 `sw`
 * - 否则若仓库含 pnpm 工程(pnpm-workspace.yaml / package.json) → `generic-pnpm`
 * - 否则 `none`
 */
export function discoverDefaultProvider(repoRoot?: string): {
  provider: BootstrapProvider
  reason: string
} {
  const root = repoRoot ?? process.cwd()
  const candidates = candidateSkillDirs(root)
  for (const dir of candidates) {
    if (!fs.existsSync(dir)) continue
    const swEntry = path.join(dir, 'sw')
    if (fs.existsSync(path.join(swEntry, 'SKILL.md'))) {
      return { provider: 'sw', reason: `discovered sw skill at ${swEntry}` }
    }
  }
  if (
    fs.existsSync(path.join(root, 'pnpm-workspace.yaml')) ||
    fs.existsSync(path.join(root, 'package.json'))
  ) {
    return { provider: 'generic-pnpm', reason: `pnpm/package.json detected at ${root}` }
  }
  return { provider: 'none', reason: 'no skill or pnpm project detected' }
}

function candidateSkillDirs(repoRoot: string): string[] {
  // 仅扫描项目内 skill 目录;全局 ~/.claude/skills 不属于"项目可用",discovery 时忽略。
  return [path.resolve(repoRoot, '.agents/skills')]
}
