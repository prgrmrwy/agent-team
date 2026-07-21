import { z } from 'zod'
import { AgentId, ArtifactId, RelPath, TaskId, Timestamp } from './common.js'
import { ArtifactType } from './enums.js'

/**
 * 制品元数据（artifact-management spec）。
 * 文件内容不存库，存在 task 目录里 path 指向的文件；这里只存索引 + refs。
 */
export const Artifact = z.object({
  id: ArtifactId,
  taskId: TaskId,
  /** 任务目录内相对路径，如 'eng/test-report.md' */
  path: RelPath,
  type: ArtifactType,
  /** 产出该制品的 agent */
  producer: AgentId,
  summary: z.string().default(''),
  /** 指向其他 artifact（双向锚定的正向边）*/
  refs: z.array(ArtifactId).default([]),
  createdAt: Timestamp,
})
export type Artifact = z.infer<typeof Artifact>
