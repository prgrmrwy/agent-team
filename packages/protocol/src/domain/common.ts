import { z } from 'zod'

/**
 * 共享原子类型。M1 用普通 string 作为 id（短 nanoid），
 * 不引入 branded type 以免前后端 infer 噪声；需要更强约束时再加 .brand()。
 */

/** ISO 8601 时间戳字符串 */
export const Timestamp = z.string().datetime()
export type Timestamp = z.infer<typeof Timestamp>

export const TaskId = z.string().min(1)
export const ProjectId = z.string().min(1)
export const SeatId = z.string().min(1)
export const AgentId = z.string().min(1)
export const MessageId = z.string().min(1)
export const ArtifactId = z.string().min(1)

/** 任务目录内的相对路径（不允许绝对路径 / 越界，由后端进一步校验）*/
export const RelPath = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith('/') && !p.includes('..'), {
    message: 'path must be a relative path within the task workdir (no leading / or ..)',
  })
export type RelPath = z.infer<typeof RelPath>
