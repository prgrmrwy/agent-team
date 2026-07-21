/**
 * @agent-team/protocol — 前后端唯一共享契约。
 * 数据模型 zod schema + WS/REST/MCP 协议。改这里 = 改全栈契约。
 */

// 枚举 + 原子类型
export * from './domain/enums.js'
export * from './domain/common.js'

// 数据模型
export * from './domain/project.js'
export * from './domain/task.js'
export * from './domain/seat.js'
export * from './domain/agent.js'
export * from './domain/factory.js'
export * from './domain/artifact.js'
export * from './domain/message.js'
export * from './domain/bootstrap.js'
export * from './domain/token-usage.js'

// 通信协议
export * from './protocol/ws.js'
export * from './protocol/rest.js'
export * from './protocol/mcp.js'
