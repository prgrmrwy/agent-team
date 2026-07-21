import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDb, runMigrations } from './client.js'
import type { DbClient } from './client.js'
import type { Logger } from '../util/logger.js'

export type { DbClient } from './client.js'
export { openDb, runMigrations } from './client.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const INDEX_MIGRATIONS_DIR = path.join(__dirname, 'migrations-index')
const TASK_MIGRATIONS_DIR = path.join(__dirname, 'migrations-task')

/** 打开并迁移全局索引 DB */
export function openIndexDb(indexDbPath: string, log?: Logger): DbClient {
  const db = openDb(indexDbPath, log)
  runMigrations(db, INDEX_MIGRATIONS_DIR, log)
  return db
}

/** 打开并迁移单个 task DB */
export function openTaskDb(taskDbPath: string, log?: Logger): DbClient {
  const db = openDb(taskDbPath, log)
  runMigrations(db, TASK_MIGRATIONS_DIR, log)
  return db
}
