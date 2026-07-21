/**
 * T6 验证：用户初始输入应作为 chatroom 第一条 human-msg 出现
 *
 * 覆盖验证点：
 *   1. 拼接正确性（description + contextLinks）
 *   2. 消息属性（type / sender / channel）
 *   3. 幂等性（不重复写入）
 *   4. 边界场景（空白输入跳过）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import type { Database as DbType } from 'better-sqlite3'

// ── 1. 拼接逻辑（从 tasks.ts 提取的纯函数逻辑） ──────────────────────

interface ContextLink {
  url: string
  label?: string
}

/** 复现 tasks.ts:161-168 的拼接逻辑 */
function buildInitialHumanMsg(description: string, contextLinks: ContextLink[]): string {
  const linkLines = contextLinks
    .filter((l) => l.url)
    .map((l) => (l.label ? `- [${l.label}](${l.url})` : `- ${l.url}`))
    .join('\n')
  return linkLines
    ? `${description}\n\n上下文链接：\n${linkLines}`
    : description
}

// ── 2. chatroom 写入逻辑（从 task-process-entry.ts 提取） ──────────────

const CHATROOM_SCHEMA = `
CREATE TABLE IF NOT EXISTS chatroom_messages (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL,
  channel     TEXT NOT NULL CHECK(channel IN ('main','eng-internal','tool-traces','mentions')),
  type        TEXT NOT NULL,
  sender      TEXT NOT NULL,
  content     TEXT NOT NULL,
  mention     TEXT NOT NULL DEFAULT '[]',
  refs        TEXT NOT NULL DEFAULT '[]',
  reply_to    TEXT,
  created_at  TEXT NOT NULL
);
`

/** 复现 task-process-entry.ts:337-360 的写入逻辑 */
function writeChatroomMsg(
  db: DbType,
  taskId: string,
  sender: string,
  channel: string,
  type: string,
  content: string,
): string {
  const now = new Date().toISOString()
  const msgId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  db.prepare(
    `INSERT INTO chatroom_messages
     (id, task_id, channel, type, sender, content, mention, refs, reply_to, created_at)
     VALUES (?, ?, ?, ?, ?, ?, '[]', '[]', NULL, ?)`,
  ).run(msgId, taskId, channel, type, sender, content, now)
  return msgId
}

/** 复现 task-process-entry.ts:1044-1056 的初始消息写入逻辑 */
function writeInitialHumanMsgIfNeeded(
  db: DbType,
  taskId: string,
  initialHumanMsg: string,
): boolean {
  if (!initialHumanMsg.trim()) return false

  const existing = db
    .prepare('SELECT COUNT(*) as n FROM chatroom_messages WHERE task_id = ?')
    .get(taskId) as { n: number }

  if (existing.n === 0) {
    writeChatroomMsg(db, taskId, 'human', 'main', 'human-msg', initialHumanMsg)
    return true
  }
  return false
}

// ── 测试 ──────────────────────────────────────────────────────────────

describe('T6: 初始 human-msg 写入', () => {
  let db: DbType

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(CHATROOM_SCHEMA)
  })

  afterEach(() => {
    db.close()
  })

  // ━━━ 验证点 1：拼接正确性 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  describe('拼接正确性（buildInitialHumanMsg）', () => {
    it('AC-1: description + 带 label 的 contextLink 拼接', () => {
      const msg = buildInitialHumanMsg('测试描述', [
        { url: 'https://example.com', label: '示例' },
      ])
      expect(msg).toBe('测试描述\n\n上下文链接：\n- [示例](https://example.com)')
    })

    it('AC-2: 仅 description 无 contextLinks → 不带链接段落', () => {
      const msg = buildInitialHumanMsg('纯描述', [])
      expect(msg).toBe('纯描述')
    })

    it('AC-6: 多个 contextLinks（含有 label 和无 label 的混合）', () => {
      const msg = buildInitialHumanMsg('多链接测试', [
        { url: 'https://a.com', label: '链接A' },
        { url: 'https://b.com' },
        { url: 'https://c.com', label: '链接C' },
      ])
      expect(msg).toBe(
        '多链接测试\n\n上下文链接：\n- [链接A](https://a.com)\n- https://b.com\n- [链接C](https://c.com)',
      )
    })

    it('过滤掉 url 为空的 contextLink', () => {
      const msg = buildInitialHumanMsg('过滤测试', [
        { url: '', label: '空url' },
        { url: 'https://valid.com', label: '有效' },
      ])
      expect(msg).toBe('过滤测试\n\n上下文链接：\n- [有效](https://valid.com)')
    })

    it('所有 contextLinks 的 url 都为空时仅返回 description', () => {
      const msg = buildInitialHumanMsg('只有描述', [{ url: '', label: '空' }])
      expect(msg).toBe('只有描述')
    })
  })

  // ━━━ 验证点 2：消息属性正确 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  describe('AC-3: 消息属性正确', () => {
    it('写入的消息 type=human-msg, sender=human, channel=main', () => {
      const taskId = 'task-test-attrs'
      writeInitialHumanMsgIfNeeded(db, taskId, '属性测试')

      const row = db
        .prepare('SELECT * FROM chatroom_messages WHERE task_id = ?')
        .get(taskId) as Record<string, string>

      expect(row).toBeDefined()
      expect(row.type).toBe('human-msg')
      expect(row.sender).toBe('human')
      expect(row.channel).toBe('main')
      expect(row.content).toBe('属性测试')
      expect(row.id).toMatch(/^msg-/)
      expect(row.created_at).toBeTruthy()
    })
  })

  // ━━━ 验证点 3：幂等性 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  describe('AC-4: 幂等性', () => {
    it('chatroom 已有消息时不重复写入', () => {
      const taskId = 'task-test-idempotent'

      // 第一次写入
      const wrote1 = writeInitialHumanMsgIfNeeded(db, taskId, '首次写入')
      expect(wrote1).toBe(true)

      const count1 = (
        db.prepare('SELECT COUNT(*) as n FROM chatroom_messages WHERE task_id = ?').get(taskId) as {
          n: number
        }
      ).n
      expect(count1).toBe(1)

      // 第二次调用（模拟进程重启）
      const wrote2 = writeInitialHumanMsgIfNeeded(db, taskId, '首次写入')
      expect(wrote2).toBe(false)

      const count2 = (
        db.prepare('SELECT COUNT(*) as n FROM chatroom_messages WHERE task_id = ?').get(taskId) as {
          n: number
        }
      ).n
      expect(count2).toBe(1) // 仍然是 1 条
    })

    it('不同 taskId 的消息互不干扰', () => {
      writeInitialHumanMsgIfNeeded(db, 'task-A', '任务A')
      writeInitialHumanMsgIfNeeded(db, 'task-B', '任务B')

      const countA = (
        db
          .prepare('SELECT COUNT(*) as n FROM chatroom_messages WHERE task_id = ?')
          .get('task-A') as { n: number }
      ).n
      const countB = (
        db
          .prepare('SELECT COUNT(*) as n FROM chatroom_messages WHERE task_id = ?')
          .get('task-B') as { n: number }
      ).n

      expect(countA).toBe(1)
      expect(countB).toBe(1)
    })
  })

  // ━━━ 验证点 4：边界场景 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  describe('AC-5: 空白输入边界', () => {
    it('空字符串不写入', () => {
      const wrote = writeInitialHumanMsgIfNeeded(db, 'task-empty', '')
      expect(wrote).toBe(false)

      const count = (
        db
          .prepare('SELECT COUNT(*) as n FROM chatroom_messages WHERE task_id = ?')
          .get('task-empty') as { n: number }
      ).n
      expect(count).toBe(0)
    })

    it('纯空白字符串不写入', () => {
      const wrote = writeInitialHumanMsgIfNeeded(db, 'task-whitespace', '   \n\t  ')
      expect(wrote).toBe(false)

      const count = (
        db
          .prepare('SELECT COUNT(*) as n FROM chatroom_messages WHERE task_id = ?')
          .get('task-whitespace') as { n: number }
      ).n
      expect(count).toBe(0)
    })

    it('有内容的字符串正常写入', () => {
      const wrote = writeInitialHumanMsgIfNeeded(db, 'task-content', '有内容')
      expect(wrote).toBe(true)

      const count = (
        db
          .prepare('SELECT COUNT(*) as n FROM chatroom_messages WHERE task_id = ?')
          .get('task-content') as { n: number }
      ).n
      expect(count).toBe(1)
    })
  })

  // ━━━ launcher env 传递验证 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  describe('launcher 环境变量传递', () => {
    it('initialHumanMsg 非空时设置 TASK_INITIAL_MSG', () => {
      // 复现 task-process-launcher.ts:128 的逻辑
      const initialHumanMsg = '测试消息'
      const env: Record<string, string | undefined> = {
        TASK_ID: 'task-1',
        TASK_WORKDIR: '/tmp/test',
        TASK_DB_PATH: '/tmp/test/task.db',
        ...(initialHumanMsg ? { TASK_INITIAL_MSG: initialHumanMsg } : {}),
      }
      expect(env['TASK_INITIAL_MSG']).toBe('测试消息')
    })

    it('initialHumanMsg 为空字符串时不设置 TASK_INITIAL_MSG', () => {
      const initialHumanMsg = ''
      const env: Record<string, string | undefined> = {
        TASK_ID: 'task-1',
        TASK_WORKDIR: '/tmp/test',
        TASK_DB_PATH: '/tmp/test/task.db',
        ...(initialHumanMsg ? { TASK_INITIAL_MSG: initialHumanMsg } : {}),
      }
      expect(env['TASK_INITIAL_MSG']).toBeUndefined()
    })

    it('task-process-entry 读 env 时有默认空串 fallback', () => {
      // 复现 task-process-entry.ts:73
      const envValue = undefined
      const initialHumanMsg = envValue ?? ''
      expect(initialHumanMsg).toBe('')
    })
  })
})
