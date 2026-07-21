/**
 * 组 10: factory-repo.ts
 * 运行时查询 + 版本化保存（写 factory_versions 表 + 备份旧 yaml）。
 * 操作全局索引 DB（index.db）的 factory_versions 表。
 */

import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import type { DbClient } from '../../db/client.js'
import type { Factory } from '@agent-team/protocol'
import { Factory as FactorySchema } from '@agent-team/protocol'
import type { Logger } from '../../util/logger.js'

export interface FactoryVersionRow {
  id: number
  name: string
  version: number
  yaml_snapshot: string
  created_at: string
}

/**
 * 保存工厂新版本：
 * 1. 把旧 yaml 备份为 <name>.v<oldVersion>.yaml.bak
 * 2. 写新版 yaml（version +1）
 * 3. 在 factory_versions 表插入记录
 */
export function saveFactory(
  db: DbClient,
  factoriesDir: string,
  factory: Factory,
  log: Logger
): Factory {
  const currentYamlPath = path.join(factoriesDir, `${factory.name}.yaml`)
  const newVersion = factory.version + 1

  // 备份旧 yaml
  if (fs.existsSync(currentYamlPath)) {
    const oldContent = fs.readFileSync(currentYamlPath, 'utf-8')
    const bakPath = path.join(factoriesDir, `${factory.name}.v${factory.version}.yaml.bak`)
    fs.writeFileSync(bakPath, oldContent, 'utf-8')
    log.info({ bakPath }, 'factory yaml backed up')
  }

  const newFactory: Factory = { ...factory, version: newVersion }
  const newYaml = yaml.dump(newFactory)

  if (!fs.existsSync(factoriesDir)) {
    fs.mkdirSync(factoriesDir, { recursive: true })
  }
  fs.writeFileSync(currentYamlPath, newYaml, 'utf-8')

  // 写 factory_versions 表（表由 index DB migration 创建）
  db.prepare(
    `INSERT INTO factory_versions (name, version, yaml_snapshot, created_at)
     VALUES (?, ?, ?, ?)`
  ).run(factory.name, newVersion, newYaml, new Date().toISOString())

  log.info({ name: factory.name, version: newVersion }, 'factory saved')
  return newFactory
}

/**
 * 列出某工厂的所有历史版本记录
 */
export function listFactoryVersions(db: DbClient, name: string): FactoryVersionRow[] {
  return db
    .prepare('SELECT * FROM factory_versions WHERE name = ? ORDER BY version DESC')
    .all(name) as FactoryVersionRow[]
}

/**
 * 回滚：把 v<n>.yaml.bak 拷回当前 yaml，version 写成 current+1（不允许真回到旧号）
 */
export function rollbackFactory(
  db: DbClient,
  factoriesDir: string,
  name: string,
  targetVersion: number,
  log: Logger
): Factory {
  const bakPath = path.join(factoriesDir, `${name}.v${targetVersion}.yaml.bak`)
  if (!fs.existsSync(bakPath)) {
    throw new Error(`backup not found: ${bakPath}`)
  }

  const bakContent = fs.readFileSync(bakPath, 'utf-8')
  const parsed = yaml.load(bakContent)
  const result = FactorySchema.safeParse(parsed)
  if (!result.success) {
    throw new Error(`backup yaml invalid: ${result.error.message}`)
  }

  // 找当前最大版本号
  const currentYamlPath = path.join(factoriesDir, `${name}.yaml`)
  let currentVersion = result.data.version
  if (fs.existsSync(currentYamlPath)) {
    const cur = yaml.load(fs.readFileSync(currentYamlPath, 'utf-8')) as { version?: number }
    if (typeof cur?.version === 'number') currentVersion = cur.version
  }

  return saveFactory(db, factoriesDir, { ...result.data, version: currentVersion }, log)
}
