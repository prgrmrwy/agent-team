import type { FC } from 'react'
import { formatLocal } from '../../shared/lib/time.js'
import type { Artifact } from './model.js'
import { ARTIFACT_TYPE_LABEL } from './model.js'

interface ArtifactCardProps {
  artifact: Artifact
  onClick?: () => void
}

export const ArtifactCard: FC<ArtifactCardProps> = ({ artifact, onClick }) => {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-start gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors hover:bg-accent"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-mono text-xs text-muted-foreground">{artifact.path}</span>
          <span className="shrink-0 rounded bg-secondary px-1.5 py-0.5 text-xs">
            {ARTIFACT_TYPE_LABEL[artifact.type]}
          </span>
        </div>
        {artifact.summary && (
          <p className="mt-0.5 text-xs text-muted-foreground line-clamp-1">{artifact.summary}</p>
        )}
        <span className="text-xs text-muted-foreground">{formatLocal(artifact.createdAt)}</span>
      </div>
    </button>
  )
}
