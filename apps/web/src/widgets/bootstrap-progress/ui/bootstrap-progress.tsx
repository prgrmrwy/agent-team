import { useState, type FC } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { TaskBootstrapResource, BootstrapResourceStatus } from '@agent-team/protocol'
import { restClient } from '../../../shared/api/index.js'
import { useBootstrapResources } from '../../../entities/task/index.js'

interface Props {
  taskId: string
}

/**
 * Bootstrap progress indicator — task page 顶部 + chatroom 头部都用同一组件。
 *
 * 显示规则:
 *  - 无 resource(provider=none / 早期 legacy)→ 不渲染
 *  - creating → 蓝 pulse,文字 "bootstrap <provider>/<mode>..."
 *  - ready    → 绿点 + 路径/分支摘要
 *  - failed   → 红边框 + 错误信息 + retry 按钮
 *  - retained/removed/archived/needs-review → 终态徽章(收尾后)
 */
export const BootstrapProgress: FC<Props> = ({ taskId }) => {
  const { data: resources = [] } = useBootstrapResources(taskId)
  if (resources.length === 0) return null
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '8px 20px',
        borderBottom: '1px solid var(--slate-edge)',
        background: 'linear-gradient(180deg, rgba(91,200,221,0.06), rgba(8,20,26,0.55))',
      }}
    >
      {resources.map((r) => (
        <ResourceRow key={r.id} taskId={taskId} resource={r} />
      ))}
    </div>
  )
}

const ResourceRow: FC<{ taskId: string; resource: TaskBootstrapResource }> = ({ taskId, resource }) => {
  const queryClient = useQueryClient()
  const [retryError, setRetryError] = useState<string | null>(null)
  const retry = useMutation({
    mutationFn: () => restClient.post(`/tasks/${taskId}/bootstrap/retry`),
    onSuccess: () => {
      setRetryError(null)
      queryClient.invalidateQueries({ queryKey: ['bootstrap-resources', taskId] })
    },
    onError: (err) => setRetryError((err as Error).message),
  })

  const tone = statusTone(resource.status)
  const isFailed = resource.status === 'failed'
  const isCreating = resource.status === 'creating'

  return (
    <div
      data-testid={`bootstrap-resource-${resource.id}`}
      data-status={resource.status}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        color: 'var(--ink-soft)',
        fontFamily: 'var(--font-chrome)',
        fontSize: 11,
      }}
    >
      <span
        aria-hidden="true"
        className={isCreating ? 'ab-pulse' : ''}
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: `var(--${tone.color})`,
          boxShadow: `0 0 6px var(--${tone.color})`,
          flexShrink: 0,
        }}
      />
      <span className="ab-eyebrow" style={{ color: `var(--${tone.color})`, whiteSpace: 'nowrap' }}>
        {tone.label}
      </span>
      <span style={{ color: 'var(--ink-dim)', whiteSpace: 'nowrap' }}>
        {resource.kind} · {resource.provider}
        {resource.mode ? `/${resource.mode}` : ''}
        {resource.attempts > 1 ? ` · attempt ${resource.attempts}` : ''}
      </span>
      <ResourceSummary resource={resource} isFailed={isFailed} />
      {isFailed && (
        <button
          type="button"
          onClick={() => retry.mutate()}
          disabled={retry.isPending}
          data-testid={`bootstrap-retry-${resource.id}`}
          style={{
            background: 'rgba(184,58,90,0.12)',
            border: '1px solid var(--malice)',
            color: 'var(--malice)',
            padding: '2px 8px',
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            borderRadius: 2,
            cursor: retry.isPending ? 'wait' : 'pointer',
            fontFamily: 'var(--font-chrome)',
            whiteSpace: 'nowrap',
          }}
        >
          {retry.isPending ? 'retrying…' : 'retry'}
        </button>
      )}
      {retryError && (
        <span style={{ color: 'var(--malice)', fontSize: 10 }}>{retryError}</span>
      )}
    </div>
  )
}

const ResourceSummary: FC<{ resource: TaskBootstrapResource; isFailed: boolean }> = ({
  resource,
  isFailed,
}) => {
  const text = resource.error ?? resource.summary ?? resource.path ?? ''
  const worktreeHref = worktreeVscodeHref(resource)
  const commonStyle = {
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: isFailed ? 'var(--malice)' : 'var(--ink-dim)',
  } as const
  if (worktreeHref && resource.path) {
    const suffix = text.startsWith(resource.path) ? text.slice(resource.path.length) : ''
    const hasSeparateSummary = text && text !== resource.path && !text.startsWith(resource.path)
    return (
      <span style={commonStyle} title={text}>
        <a
          href={worktreeHref}
          style={{ color: 'var(--cyan)', textDecoration: 'underline' }}
          title={resource.path}
        >
          {resource.path}
        </a>
        {suffix}
        {hasSeparateSummary && <span> · {text}</span>}
      </span>
    )
  }
  return (
    <span style={commonStyle} title={text}>
      {text}
    </span>
  )
}

export const ResourceSummaryForTest = ResourceSummary

export function worktreeVscodeHref(resource: Pick<TaskBootstrapResource, 'kind' | 'path'>): string | null {
  if (resource.kind !== 'worktree' || !resource.path) return null
  return `vscode://file/${encodeURI(resource.path)}`
}

function statusTone(status: BootstrapResourceStatus): { label: string; color: string } {
  switch (status) {
    case 'creating':
      return { label: 'bootstrap', color: 'cyan' }
    case 'ready':
      return { label: 'ready', color: 'engineer' }
    case 'failed':
      return { label: 'failed', color: 'malice' }
    case 'retained':
      return { label: 'retained', color: 'cyan' }
    case 'removed':
      return { label: 'removed', color: 'ink-dimmer' }
    case 'archived':
      return { label: 'archived', color: 'planner' }
    case 'needs-review':
      return { label: 'needs review', color: 'qa' }
  }
}
