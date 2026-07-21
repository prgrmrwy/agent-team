/**
 * 组 10: factory-schema.ts
 * Factory yaml 的 zod schema，对齐 packages/protocol 的 Factory 类型。
 * 直接 re-export 并补充运行时辅助函数。
 */

export { Factory, McpServerDecl } from '@agent-team/protocol'
export type { Factory as FactorySchema, McpServerDecl as McpServerDeclType } from '@agent-team/protocol'
