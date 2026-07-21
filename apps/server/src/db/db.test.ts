import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { tmpdir } from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { openDb, runMigrations } from './client.js'
import { openIndexDb, openTaskDb } from './index.js'
import { createRepo } from './repo.js'
import { getTaskUsage } from './token-usage-repo.js'

function tmpDir(): string {
  const d = path.join(tmpdir(), `agent-team-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  fs.mkdirSync(d, { recursive: true })
  return d
}

describe('openDb + WAL', () => {
  it('should open a DB with WAL mode', () => {
    const dir = tmpDir()
    const db = openDb(path.join(dir, 'test.db'))
    const row = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }
    expect(row.journal_mode).toBe('wal')
    db.close()
    fs.rmSync(dir, { recursive: true })
  })
})

describe('runMigrations', () => {
  it('should run migration files in order', () => {
    const dir = tmpDir()
    const migrationsDir = path.join(dir, 'migrations')
    fs.mkdirSync(migrationsDir)

    fs.writeFileSync(
      path.join(migrationsDir, '001_create_foo.sql'),
      'CREATE TABLE foo (id TEXT PRIMARY KEY, name TEXT NOT NULL)'
    )

    const db = openDb(path.join(dir, 'test.db'))
    runMigrations(db, migrationsDir)

    // 表存在
    const info = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='foo'").get()
    expect(info).toBeDefined()

    // _migrations 记录了这条
    const applied = db.prepare('SELECT name FROM _migrations').all() as { name: string }[]
    expect(applied.map((r) => r.name)).toContain('001_create_foo.sql')

    db.close()
    fs.rmSync(dir, { recursive: true })
  })

  it('should skip already-applied migrations on second run', () => {
    const dir = tmpDir()
    const migrationsDir = path.join(dir, 'migrations')
    fs.mkdirSync(migrationsDir)

    fs.writeFileSync(
      path.join(migrationsDir, '001_create_bar.sql'),
      'CREATE TABLE bar (id TEXT PRIMARY KEY)'
    )

    const dbPath = path.join(dir, 'test.db')
    const db1 = openDb(dbPath)
    runMigrations(db1, migrationsDir)
    db1.close()

    // 第二次打开，migration 不应重跑（不报错）
    const db2 = openDb(dbPath)
    expect(() => runMigrations(db2, migrationsDir)).not.toThrow()
    db2.close()

    fs.rmSync(dir, { recursive: true })
  })
})

describe('openIndexDb', () => {
  it('should create index DB with expected tables', () => {
    const dir = tmpDir()
    const db = openIndexDb(path.join(dir, 'index.db'))

    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[])
      .map((r) => r.name)

    expect(tables).toContain('projects')
    expect(tables).toContain('tasks_meta')
    expect(tables).toContain('factory_versions')
    expect(tables).toContain('factory_tuning_queue')

    db.close()
    fs.rmSync(dir, { recursive: true })
  })
})

describe('openTaskDb', () => {
  it('should create task DB with expected tables', () => {
    const dir = tmpDir()
    const db = openTaskDb(path.join(dir, 'task.db'))

    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[])
      .map((r) => r.name)

    expect(tables).toContain('chatroom_messages')
    expect(tables).toContain('seats')
    expect(tables).toContain('agents')
    expect(tables).toContain('artifacts')
    expect(tables).toContain('context_access_log')
    expect(tables).toContain('state_history')
    expect(tables).toContain('bootstrap_config')
    expect(tables).toContain('bootstrap_resources')
    expect(tables).toContain('token_usage_events')

    db.close()
    fs.rmSync(dir, { recursive: true })
  })

  it('should return empty usage aggregate for legacy task DBs without token_usage_events', () => {
    const dir = tmpDir()
    const db = openDb(path.join(dir, 'legacy-task.db'))
    db.exec(
      `CREATE TABLE chatroom_messages (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        type TEXT NOT NULL,
        sender TEXT NOT NULL,
        content TEXT NOT NULL,
        mention TEXT NOT NULL DEFAULT '[]',
        refs TEXT NOT NULL DEFAULT '[]',
        reply_to TEXT,
        created_at TEXT NOT NULL
      )`,
    )

    expect(getTaskUsage(db, 'task-legacy')).toEqual({
      taskId: 'task-legacy',
      totals: {
        runtime: {
          inputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          totalTokens: 0,
        },
        chatroomCorpus: {
          inputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          totalTokens: 0,
        },
        chatroomRead: {
          inputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          totalTokens: 0,
        },
      },
      agents: [],
    })

    db.close()
    fs.rmSync(dir, { recursive: true })
  })
})

describe('createRepo CRUD', () => {
  it('should insert and findById', () => {
    const dir = tmpDir()
    const db = openDb(path.join(dir, 'test.db'))
    db.exec('CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, repo_path TEXT, created_at TEXT NOT NULL)')

    const repo = createRepo<{ id: string; name: string; repo_path: string | null; created_at: string }>(db, 'projects')

    repo.insert({ id: 'proj-1', name: 'Test', repo_path: null, created_at: new Date().toISOString() })
    const found = repo.findById('proj-1')

    expect(found).not.toBeNull()
    expect(found?.name).toBe('Test')

    db.close()
    fs.rmSync(dir, { recursive: true })
  })

  it('should findAll', () => {
    const dir = tmpDir()
    const db = openDb(path.join(dir, 'test.db'))
    db.exec('CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, repo_path TEXT, created_at TEXT NOT NULL)')

    const repo = createRepo<{ id: string; name: string; repo_path: string | null; created_at: string }>(db, 'projects')
    const now = new Date().toISOString()
    repo.insert({ id: 'p1', name: 'A', repo_path: null, created_at: now })
    repo.insert({ id: 'p2', name: 'B', repo_path: null, created_at: now })

    expect(repo.findAll()).toHaveLength(2)

    db.close()
    fs.rmSync(dir, { recursive: true })
  })

  it('should update', () => {
    const dir = tmpDir()
    const db = openDb(path.join(dir, 'test.db'))
    db.exec('CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, repo_path TEXT, created_at TEXT NOT NULL)')

    const repo = createRepo<{ id: string; name: string; repo_path: string | null; created_at: string }>(db, 'projects')
    const now = new Date().toISOString()
    repo.insert({ id: 'p1', name: 'Old', repo_path: null, created_at: now })
    repo.update('p1', { name: 'New' })

    expect(repo.findById('p1')?.name).toBe('New')

    db.close()
    fs.rmSync(dir, { recursive: true })
  })

  it('should delete', () => {
    const dir = tmpDir()
    const db = openDb(path.join(dir, 'test.db'))
    db.exec('CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, repo_path TEXT, created_at TEXT NOT NULL)')

    const repo = createRepo<{ id: string; name: string; repo_path: string | null; created_at: string }>(db, 'projects')
    const now = new Date().toISOString()
    repo.insert({ id: 'p1', name: 'ToDelete', repo_path: null, created_at: now })
    repo.delete('p1')

    expect(repo.findById('p1')).toBeNull()

    db.close()
    fs.rmSync(dir, { recursive: true })
  })
})

describe('WAL concurrent reads', () => {
  it('should support multiple concurrent readers', () => {
    const dir = tmpDir()
    const dbPath = path.join(dir, 'concurrent.db')

    // writer
    const writer = openDb(dbPath)
    writer.exec('CREATE TABLE nums (n INTEGER)')
    writer.prepare('INSERT INTO nums VALUES (?)').run(42)

    // two readers open same file
    const r1 = openDb(dbPath)
    const r2 = openDb(dbPath)

    const v1 = r1.prepare('SELECT n FROM nums').get() as { n: number }
    const v2 = r2.prepare('SELECT n FROM nums').get() as { n: number }

    expect(v1.n).toBe(42)
    expect(v2.n).toBe(42)

    writer.close()
    r1.close()
    r2.close()
    fs.rmSync(dir, { recursive: true })
  })
})
