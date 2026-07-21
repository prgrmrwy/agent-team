import { Router } from 'express'
import type { Request, Response } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { getAllFactories } from '../../domain/factory/factory-loader.js'
import type { Logger } from '../../util/logger.js'

interface SkillMeta {
  name: string
  description: string
  source: 'project' | 'global' | 'factory'
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * GET /skills — 仅列出 factory YAML 显式 recommendedSkills 中声明的 skill。
 * 给前端任务创建表单的 @skill picker 用。M3 T2 新增。
 *
 * 元信息可从多个 skill source 解析,但可选范围只由 factory 决定。
 */
export function createSkillsRouter(log: Logger): Router {
  const router = Router()

  router.get('/', (_req: Request, res: Response) => {
    const recommended = recommendedSkillNames()
    const byName = new Map<string, SkillMeta>()
    for (const source of skillSources()) {
      for (const skill of readSkillsFromDir(source.dir, source.kind, log)) {
        if (!recommended.has(skill.name)) continue
        if (!byName.has(skill.name)) byName.set(skill.name, skill)
      }
    }
    for (const name of recommended) {
      if (!byName.has(name)) {
        byName.set(name, { name, description: '', source: 'factory' })
      }
    }
    const skills = Array.from(byName.values())
    skills.sort((a, b) => a.name.localeCompare(b.name))
    res.json(skills)
  })

  return router
}

function recommendedSkillNames(): Set<string> {
  return new Set(getAllFactories().flatMap((factory) => factory.recommendedSkills))
}

function skillSources(): Array<{ dir: string; kind: Exclude<SkillMeta['source'], 'factory'> }> {
  const projectSkillsDir = findExistingProjectSkillsDir()
  const dirs = [
    projectSkillsDir,
    path.join(os.homedir(), '.claude', 'skills'),
    path.join(os.homedir(), '.agents', 'skills'),
    path.join(os.homedir(), '.codex', 'skills'),
  ].filter((dir): dir is string => Boolean(dir))

  const uniqueDirs = Array.from(new Set(dirs)).filter((dir) => fs.existsSync(dir))
  return uniqueDirs.map((dir) => ({
    dir,
    kind: dir === projectSkillsDir ? 'project' as const : 'global' as const,
  }))
}

function findExistingProjectSkillsDir(): string | null {
  const candidates = [
    path.resolve(process.cwd(), '.agents/skills'),
    path.resolve(process.cwd(), '../../.agents/skills'),
    path.resolve(__dirname, '../../../../../.agents/skills'),
  ]
  return candidates.find((dir) => fs.existsSync(dir)) ?? null
}

function readSkillsFromDir(
  dir: string,
  source: SkillMeta['source'],
  log: Logger,
): SkillMeta[] {
  if (!fs.existsSync(dir)) return []

  const skills: SkillMeta[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const skillPath = path.join(dir, entry.name, 'SKILL.md')
    if (!fs.existsSync(skillPath)) continue
    try {
      const content = fs.readFileSync(skillPath, 'utf-8')
      const fm = parseFrontmatter(content)
      skills.push({
        name: fm.name ?? entry.name,
        description: fm.description ?? '',
        source,
      })
    } catch (err) {
      log.warn({ err, skill: entry.name, source }, 'failed to parse SKILL.md, skipped')
    }
  }
  return skills
}

/** 简易 YAML frontmatter 解析(只取 name / description,不处理 multiline) */
function parseFrontmatter(content: string): { name?: string; description?: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return {}
  const result: { name?: string; description?: string } = {}
  for (const line of (match[1] ?? '').split('\n')) {
    const m = line.match(/^(name|description):\s*(.*)$/)
    if (m && m[1] && m[2] !== undefined) {
      result[m[1] as 'name' | 'description'] = m[2].trim().replace(/^['"]|['"]$/g, '')
    }
  }
  return result
}
