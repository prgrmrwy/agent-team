import { nanoid } from 'nanoid'

/**
 * 短码 ID 生成。nanoid 默认 21 字符，URL-safe，碰撞概率极低。
 * 各实体用不同前缀便于日志追踪。
 */

export function newTaskId(): string {
  return `task-${nanoid(10)}`
}

export function newAgentId(factory: string): string {
  return `${factory}-${nanoid(8)}`
}

export function newSeatId(): string {
  return `seat-${nanoid(8)}`
}

export function newMessageId(): string {
  return `msg-${nanoid(10)}`
}

export function newArtifactId(): string {
  return `art-${nanoid(10)}`
}

export function newProjectId(): string {
  return `proj-${nanoid(8)}`
}

export function newTokenUsageId(): string {
  return `usage-${nanoid(12)}`
}
