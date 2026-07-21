/**
 * 轻量客户端 ID 生成（用于临时前端 key，不用于服务端持久化 ID）。
 * 持久化 ID 由后端 nanoid 生成，前端收到后直接用。
 */

let counter = 0

/** 生成浏览器端临时唯一 key（不保证全局唯一，仅用于 React key）。 */
export function tempKey(prefix = 'k'): string {
  return `${prefix}-${Date.now()}-${++counter}`
}

/** 检查字符串是否为非空 ID。 */
export function isValidId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0
}
