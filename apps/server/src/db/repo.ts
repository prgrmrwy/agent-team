import type { DbClient } from './client.js'

/**
 * 通用 CRUD repo 模板（better-sqlite3 同步 API）。
 * 只做最基础的 insert / findById / findAll / update / delete。
 * 复杂查询由各业务 repo 直接写 SQL。
 */
export interface Repo<T> {
  insert(row: T): void
  findById(id: string): T | null
  findAll(): T[]
  update(id: string, partial: Partial<T>): void
  delete(id: string): void
}

/**
 * 创建一个基础 CRUD repo。
 *
 * @param db      SQLite 连接
 * @param table   表名
 * @param idCol   主键列名（默认 'id'）
 * @param fromRow 把原始行对象转成 T（可做 JSON.parse 等）
 * @param toRow   把 T 转成插入用的 plain 对象
 */
export function createRepo<T extends Record<string, unknown>>(
  db: DbClient,
  table: string,
  idCol = 'id',
  fromRow: (row: Record<string, unknown>) => T = (r) => r as T,
  toRow: (entity: T) => Record<string, unknown> = (e) => e
): Repo<T> {
  return {
    insert(entity: T) {
      const row = toRow(entity)
      const cols = Object.keys(row)
      const placeholders = cols.map(() => '?').join(', ')
      const values = Object.values(row)
      db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`).run(...values)
    },

    findById(id: string): T | null {
      const row = db.prepare(`SELECT * FROM ${table} WHERE ${idCol} = ?`).get(id)
      if (!row) return null
      return fromRow(row as Record<string, unknown>)
    },

    findAll(): T[] {
      const rows = db.prepare(`SELECT * FROM ${table}`).all()
      return rows.map((r) => fromRow(r as Record<string, unknown>))
    },

    update(id: string, partial: Partial<T>) {
      const row = toRow(partial as T)
      const sets = Object.keys(row)
        .map((k) => `${k} = ?`)
        .join(', ')
      const values = [...Object.values(row), id]
      db.prepare(`UPDATE ${table} SET ${sets} WHERE ${idCol} = ?`).run(...values)
    },

    delete(id: string) {
      db.prepare(`DELETE FROM ${table} WHERE ${idCol} = ?`).run(id)
    },
  }
}
