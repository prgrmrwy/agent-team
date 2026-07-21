import { type FC, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { Dialog } from '../../../shared/ui/dialog.js'
import { formatLocal } from '../../../shared/lib/time.js'
import type { Artifact } from '@agent-team/protocol'
import { ARTIFACT_TYPE_LABEL } from '../../../entities/artifact/index.js'

interface ArtifactPreviewProps {
  artifact: Artifact
  content?: string
  open: boolean
  onClose: () => void
}

export const ArtifactPreview: FC<ArtifactPreviewProps> = ({
  artifact,
  content,
  open,
  onClose,
}) => {
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => { if (!o) onClose() }}
      title={artifact.path}
    >
      <div className="flex flex-col gap-3">
        {/* 元数据行 */}
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="rounded bg-secondary px-1.5 py-0.5">
            {ARTIFACT_TYPE_LABEL[artifact.type]}
          </span>
          <span>{formatLocal(artifact.createdAt)}</span>
          {artifact.summary && (
            <span className="italic">{artifact.summary}</span>
          )}
        </div>

        {/* Refs */}
        {artifact.refs.length > 0 && (
          <div className="rounded-md bg-muted px-3 py-2 text-xs">
            <span className="font-medium">引用：</span>
            {artifact.refs.join('、')}
          </div>
        )}

        {/* 内容区 */}
        <div className="max-h-[60vh] overflow-y-auto rounded-md border bg-background p-4">
          {content ? (
            <div className="prose prose-sm max-w-none dark:prose-invert">
              <ReactMarkdown>{content}</ReactMarkdown>
            </div>
          ) : (
            <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
              <div className="text-center">
                <p>内容将在后端就绪后从文件系统加载</p>
                <p className="mt-1 font-mono text-xs">{artifact.path}</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </Dialog>
  )
}

/** 触发器 hook：管理 artifact 预览的开关状态 */
export function useArtifactPreview() {
  const [selected, setSelected] = useState<Artifact | null>(null)
  const open = selected !== null
  return {
    selected,
    open,
    openArtifact: setSelected,
    close: () => setSelected(null),
  }
}
