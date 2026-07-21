import { z } from 'zod'
import { ProjectId, Timestamp } from './common.js'

export const Project = z.object({
  id: ProjectId,
  name: z.string().min(1),
  /** 项目根目录（用户代码仓库路径）*/
  repoPath: z.string().optional(),
  createdAt: Timestamp,
})
export type Project = z.infer<typeof Project>
