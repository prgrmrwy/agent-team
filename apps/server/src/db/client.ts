import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import type { Logger } from '../util/logger.js'

export type DbClient = Database.Database

/**
 * 打开一个 SQLite 数据库，启用 WAL 模式 + busy timeout。
 * 调用方负责 schema migration（见 runMigrations）。
 */
export function openDb(dbPath: string, log?: Logger): DbClient {
  const dir = path.dirname(dbPath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  db.pragma('foreign_keys = ON')
  db.pragma('synchronous = NORMAL')

  log?.debug({ dbPath }, 'SQLite opened')
  return db
}

/**
 * 从 migrations 目录按文件名字典序执行 .sql 文件（跳过已执行的）。
 * migration 状态记在同一个 DB 的 _migrations 表中。
 */
export function runMigrations(db: DbClient, migrationsDir: string, log?: Logger): void {
  // 确保 migration 元数据表存在
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `)

  const applied = new Set<string>(
    db.prepare('SELECT name FROM _migrations').all().map((r) => (r as { name: string }).name)
  )

  if (!fs.existsSync(migrationsDir)) {
    log?.debug({ migrationsDir }, 'no migrations dir, skipping')
    return
  }

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()

  for (const file of files) {
    if (applied.has(file)) continue

    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8')
    const runMigration = db.transaction(() => {
      db.exec(sql)
      db.prepare('INSERT INTO _migrations(name, applied_at) VALUES (?, ?)').run(
        file,
        new Date().toISOString()
      )
    })
    runMigration()
    log?.info({ file }, 'migration applied')
  }
}
