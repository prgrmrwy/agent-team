import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb, runMigrations } from '../../db/client.js'
import { TaskBootstrapRunner } from './runner.js'
import { createGenericPnpmProvider } from './generic-pnpm.js'
import { createSwProvider, parseSwOutput } from './sw.js'
import type { BootstrapProvider } from './types.js'

let tmp: string
const taskId = 'task-bootstrap-test'

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
}

function initRepo(repoRoot: string): void {
  fs.mkdirSync(repoRoot, { recursive: true })
  git(repoRoot, 'init', '--initial-branch=main', '-q')
  git(repoRoot, 'config', 'user.email', 't@example.com')
  git(repoRoot, 'config', 'user.name', 'test')
  fs.writeFileSync(path.join(repoRoot, 'README.md'), 'hello')
  git(repoRoot, 'add', '.')
  git(repoRoot, 'commit', '-q', '-m', 'init')
}

function migrateTaskDb(taskDbPath: string): void {
  const db = openDb(taskDbPath)
  const migrationsDir = path.resolve(
    new URL('../../db/migrations-task', import.meta.url).pathname,
  )
  runMigrations(db, migrationsDir)
  db.close()
}

function readResources(taskDbPath: string): Record<string, unknown>[] {
  const db = openDb(taskDbPath)
  const rows = db.prepare('SELECT * FROM bootstrap_resources').all() as Record<string, unknown>[]
  db.close()
  return rows
}

function readSystemEvents(taskDbPath: string): { content: string }[] {
  const db = openDb(taskDbPath)
  const rows = db
    .prepare(`SELECT content FROM chatroom_messages WHERE type = 'system-event' ORDER BY created_at`)
    .all() as { content: string }[]
  db.close()
  return rows
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-team-bootstrap-'))
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('TaskBootstrapRunner with generic-pnpm provider', () => {
  it('prepare creates git worktree, lean-links node_modules, and writes ready resource + system-event', async () => {
    const repoRoot = path.join(tmp, 'repo')
    initRepo(repoRoot)
    fs.mkdirSync(path.join(repoRoot, 'node_modules'), { recursive: true })

    const taskWorkdir = path.join(tmp, 'taskdir')
    fs.mkdirSync(taskWorkdir, { recursive: true })
    const taskDbPath = path.join(taskWorkdir, 'task.db')
    migrateTaskDb(taskDbPath)

    const runner = new TaskBootstrapRunner({
      taskDbPath,
      taskWorkdir,
      repoRoot,
      providers: { 'generic-pnpm': createGenericPnpmProvider() },
    })

    const resource = await runner.prepare(taskId, {
      provider: 'generic-pnpm',
      mode: 'lean',
      release: 'remove-if-clean',
      options: {},
    })

    runner.close()

    expect(resource?.status).toBe('ready')
    expect(resource?.path).toBe(path.join(taskWorkdir, 'worktree'))
    expect(resource?.branch).toBe(`task/${taskId}`)
    expect(resource?.attempts).toBe(1)
    expect(fs.existsSync(path.join(taskWorkdir, 'worktree', '.git'))).toBe(true)
    expect(fs.readlinkSync(path.join(taskWorkdir, 'worktree', 'node_modules'))).toBe(
      path.join(repoRoot, 'node_modules'),
    )

    const events = readSystemEvents(taskDbPath)
    expect(events.length).toBeGreaterThanOrEqual(2)
    expect(events.some((e) => e.content.includes('preparing'))).toBe(true)
    expect(events.some((e) => e.content.includes('bootstrap ready'))).toBe(true)
  })

  it('failed prepare and retry on same resource increments attempts', async () => {
    const repoRoot = path.join(tmp, 'not-a-repo')
    fs.mkdirSync(repoRoot, { recursive: true })
    const taskWorkdir = path.join(tmp, 'taskdir')
    fs.mkdirSync(taskWorkdir, { recursive: true })
    const taskDbPath = path.join(taskWorkdir, 'task.db')
    migrateTaskDb(taskDbPath)

    const runner = new TaskBootstrapRunner({
      taskDbPath,
      taskWorkdir,
      repoRoot,
      providers: { 'generic-pnpm': createGenericPnpmProvider() },
    })

    const first = await runner.prepare(taskId, { provider: 'generic-pnpm', mode: 'lean', release: 'remove-if-clean', options: {} })
    expect(first?.status).toBe('failed')
    expect(first?.attempts).toBe(1)
    expect(first?.error).toBeTruthy()

    const retry = await runner.prepare(taskId, { provider: 'generic-pnpm', mode: 'lean', release: 'remove-if-clean', options: {} })
    runner.close()

    expect(retry?.status).toBe('failed')
    expect(retry?.attempts).toBe(2)

    const rows = readResources(taskDbPath)
    expect(rows.length).toBe(1)
    expect(rows[0]!['attempts']).toBe(2)
  })

  it('provider=none returns null without writing a resource', async () => {
    const taskWorkdir = path.join(tmp, 'taskdir')
    fs.mkdirSync(taskWorkdir, { recursive: true })
    const taskDbPath = path.join(taskWorkdir, 'task.db')
    migrateTaskDb(taskDbPath)

    const runner = new TaskBootstrapRunner({ taskDbPath, taskWorkdir })
    const result = await runner.prepare(taskId, { provider: 'none', mode: undefined, release: 'remove-if-clean', options: {} })
    runner.close()
    expect(result).toBeNull()
    expect(readResources(taskDbPath)).toHaveLength(0)
  })

  it('release calls provider and writes terminal status', async () => {
    const taskWorkdir = path.join(tmp, 'taskdir')
    fs.mkdirSync(taskWorkdir, { recursive: true })
    const taskDbPath = path.join(taskWorkdir, 'task.db')
    migrateTaskDb(taskDbPath)

    const fakeProvider: BootstrapProvider = {
      id: 'generic',
      async prepare() {
        return { ok: true, path: '/tmp/fake', branch: 'main' }
      },
      async status(_ctx, r) {
        return { status: r.status as 'ready', path: r.path, branch: r.branch }
      },
      async release() {
        return { terminalStatus: 'archived', summary: 'snapshot saved' }
      },
    }

    const runner = new TaskBootstrapRunner({
      taskDbPath,
      taskWorkdir,
      providers: { generic: fakeProvider },
    })

    await runner.prepare(taskId, { provider: 'generic', mode: undefined, release: 'remove-if-clean', options: {} })
    const released = await runner.release(taskId)
    runner.close()

    expect(released?.status).toBe('archived')
    const rows = readResources(taskDbPath)
    expect(rows[0]!['terminal_status']).toBe('archived')
    expect(rows[0]!['summary']).toBe('snapshot saved')
  })
})

describe('sw adapter', () => {
  it('parses SW_WORKTREE / SW_BRANCH from output', () => {
    const out = [
      'some preamble',
      'SW_WORKTREE=/tmp/wt-abc',
      'SW_BRANCH=task/foo',
      'SW_BASE=origin/master',
      'done',
    ].join('\n')
    expect(parseSwOutput(out)).toEqual({
      path: '/tmp/wt-abc',
      branch: 'task/foo',
      baseRef: 'origin/master',
    })
  })

  it('returns failure when script is missing', async () => {
    const provider = createSwProvider({ startScript: path.join(tmp, 'does-not-exist.sh') })
    const result = await provider.prepare({
      taskId,
      taskWorkdir: tmp,
      repoRoot: tmp,
      mode: 'lean',
      releasePolicy: 'remove-if-clean',
      options: {},
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toMatch(/sw start script missing/)
    }
  })

  it('returns failure when script exits non-zero', async () => {
    const script = path.join(tmp, 'fail.sh')
    fs.writeFileSync(script, '#!/usr/bin/env bash\necho boom 1>&2\nexit 7\n')
    fs.chmodSync(script, 0o755)
    const provider = createSwProvider({ startScript: script })
    const result = await provider.prepare({
      taskId,
      taskWorkdir: tmp,
      repoRoot: tmp,
      mode: 'lean',
      releasePolicy: 'remove-if-clean',
      options: {},
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      // error 现在带真实尾巴(stderr/stdout 最后几行);summary 给 Nexus 提示
      expect(result.error).toMatch(/boom/)
      expect(result.summary).toMatch(/SW_WORKTREE|Nexus/)
    }
  })

  it('returns success when script emits SW_WORKTREE', async () => {
    const script = path.join(tmp, 'ok.sh')
    fs.writeFileSync(
      script,
      '#!/usr/bin/env bash\necho "SW_WORKTREE=/tmp/ok"\necho "SW_BRANCH=task/x"\n',
    )
    fs.chmodSync(script, 0o755)
    const provider = createSwProvider({ startScript: script })
    const result = await provider.prepare({
      taskId,
      taskWorkdir: tmp,
      repoRoot: tmp,
      mode: 'lean',
      releasePolicy: 'remove-if-clean',
      options: {},
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.path).toBe('/tmp/ok')
      expect(result.branch).toBe('task/x')
    }
  })

  it('release returns needs-review by default', async () => {
    const cleanScript = path.join(tmp, 'clean.sh')
    fs.writeFileSync(cleanScript, '#!/usr/bin/env bash\necho clean\n')
    const provider = createSwProvider({
      startScript: path.join(tmp, 'start.sh'),
      cleanScript,
    })
    const release = await provider.release(
      { taskId, taskWorkdir: tmp, repoRoot: tmp, mode: 'lean', releasePolicy: 'remove-if-clean', options: {} },
      {
        id: 'primary-worktree',
        taskId,
        kind: 'worktree',
        status: 'ready',
        provider: 'sw',
        path: '/tmp/sw-wt',
        attempts: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    )
    expect(release.terminalStatus).toBe('needs-review')
  })
})
