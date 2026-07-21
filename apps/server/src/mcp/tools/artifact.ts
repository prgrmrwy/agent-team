/**
 * 组 13: artifact 工具（artifact_register / artifact_list / artifact_get）
 */

import fs from 'node:fs'
import path from 'node:path'
import type { Artifact } from '@agent-team/protocol'
import {
  ArtifactRegisterInput,
  ArtifactListInput,
  ArtifactGetInput,
  ArtifactType,
} from '@agent-team/protocol'
import { newArtifactId } from '../../util/id.js'
import type { McpToolContext } from '../context.js'

export function registerArtifactTools(ctx: McpToolContext): void {
  // 4. artifact_register
  ctx.mcpServer.tool(
    'artifact_register',
    'Register a produced artifact in the task directory',
    ArtifactRegisterInput.shape,
    async (args) => {
      const input = ArtifactRegisterInput.parse(args)

      // 校验 path 在 task 目录内
      const absPath = path.resolve(ctx.taskWorkdir, input.path)
      if (!absPath.startsWith(ctx.taskWorkdir)) {
        return err('path must be within task workdir')
      }

      // 文件必须存在
      if (!fs.existsSync(absPath)) {
        return err(`file not found at ${input.path}`)
      }

      // type 不在枚举内映射到 other
      const typeResult = ArtifactType.safeParse(input.type)
      const artifactType = typeResult.success ? input.type : 'other'
      if (!typeResult.success) {
        ctx.log.warn({ type: input.type }, `unknown artifact type mapped to 'other'`)
      }

      const artifactId = newArtifactId()
      const now = new Date().toISOString()

      ctx.db
        .prepare(
          `INSERT INTO artifacts (id, task_id, path, type, producer, summary, refs, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          artifactId,
          input.taskId,
          input.path,
          artifactType,
          input.producer,
          input.summary ?? '',
          JSON.stringify(input.refs ?? []),
          now
        )

      // 广播制品事件给 WS 前端
      ctx.emitter.emit('artifact-event', {
        taskId: ctx.taskId,
        artifact: { id: artifactId, path: input.path, type: artifactType },
      })

      return ok({ artifactId })
    }
  )

  // 5. artifact_list
  ctx.mcpServer.tool(
    'artifact_list',
    'List artifacts for a task',
    ArtifactListInput.shape,
    async (args) => {
      const input = ArtifactListInput.parse(args)
      let sql = 'SELECT * FROM artifacts WHERE task_id = ?'
      const params: unknown[] = [input.taskId]
      if (input.type) {
        sql += ' AND type = ?'
        params.push(input.type)
      }
      if (input.producer) {
        sql += ' AND producer = ?'
        params.push(input.producer)
      }
      sql += ' ORDER BY created_at'

      const rows = ctx.db.prepare(sql).all(...params) as Record<string, unknown>[]
      const artifacts = rows.map(rowToArtifact)
      return ok({ artifacts })
    }
  )

  // 6. artifact_get
  ctx.mcpServer.tool(
    'artifact_get',
    'Get artifact metadata and file content',
    ArtifactGetInput.shape,
    async (args) => {
      const input = ArtifactGetInput.parse(args)
      const row = ctx.db
        .prepare('SELECT * FROM artifacts WHERE id = ?')
        .get(input.artifactId) as Record<string, unknown> | undefined

      if (!row) {
        return err(`artifact not found: ${input.artifactId}`)
      }

      const artifact = rowToArtifact(row)
      const absPath = path.join(ctx.taskWorkdir, artifact.path)

      let content = ''
      if (fs.existsSync(absPath)) {
        content = fs.readFileSync(absPath, 'utf-8')
      }

      return ok({ artifact, content })
    }
  )
}

function rowToArtifact(r: Record<string, unknown>): Artifact {
  return {
    id: r['id'] as string,
    taskId: r['task_id'] as string,
    path: r['path'] as string,
    type: r['type'] as Artifact['type'],
    producer: r['producer'] as string,
    summary: (r['summary'] as string) ?? '',
    refs: JSON.parse((r['refs'] as string) ?? '[]') as string[],
    createdAt: r['created_at'] as string,
  }
}

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] }
}

function err(reason: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error: reason }) }] }
}
