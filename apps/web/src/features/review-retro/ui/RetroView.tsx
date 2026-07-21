import { type FC } from 'react'
import ReactMarkdown from 'react-markdown'
import type { Artifact } from '@agent-team/protocol'
import { formatLocal } from '../../../shared/lib/time.js'

interface RetroViewProps {
  retroArtifact: Artifact | null
  content?: string
}

/**
 * 复盘视图（M1 只读）。
 * M2 起可在此加"入库勾选"等交互。
 */
export const RetroView: FC<RetroViewProps> = ({ retroArtifact, content }) => {
  if (!retroArtifact) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
        复盘文档尚未生成，待 Planner 在 S11 阶段产出。
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">任务复盘</h2>
        <span className="text-xs text-muted-foreground">
          {formatLocal(retroArtifact.createdAt)}
        </span>
      </div>

      {retroArtifact.summary && (
        <p className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
          {retroArtifact.summary}
        </p>
      )}

      <div className="rounded-md border bg-background p-4">
        {content ? (
          <div className="prose prose-sm max-w-none dark:prose-invert">
            <ReactMarkdown>{content}</ReactMarkdown>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            内容加载中（路径：{retroArtifact.path}）
          </p>
        )}
      </div>

      {/* M2 入库勾选占位 */}
      <div className="flex items-center gap-2 rounded-md border border-dashed p-3 text-sm text-muted-foreground">
        <input type="checkbox" disabled className="opacity-50" />
        <span>加入项目知识库（M2 接入）</span>
      </div>
    </div>
  )
}
