import type { FC, ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import rehypeHighlight from 'rehype-highlight'
import { ApiError, restClient } from '../../../shared/api/index.js'
import { env } from '../../../shared/config/index.js'
import type { RightPanelContextValue } from '../../../shared/ui/right-panel.js'

interface FileResponse {
  content: string
  path: string
  ext: string
  root: 'workspace' | 'worktree'
  truncated?: boolean
  binary?: boolean
}

interface FileViewerProps {
  taskId: string
  path: string
  embedded?: boolean
  onClose?: () => void
}

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'])
const MARKDOWN_EXTS = new Set(['md', 'markdown'])
const CODE_EXTS = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'json',
  'yaml',
  'yml',
  'css',
  'scss',
  'html',
  'sh',
  'bash',
  'mdx',
  'txt',
  'sql',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'swift',
  'c',
  'cc',
  'cpp',
  'h',
  'hpp',
])

const PATH_EXT_RE =
  /^(?:\.{1,2}\/)?(?:[\w@.+-]+\/)+[\w@.+-]+\.[A-Za-z0-9]{1,12}$|^[\w@.+-]+\.[A-Za-z0-9]{1,12}$/

export function isLocalFileHref(href: string | undefined): href is string {
  if (!href) return false
  if (/^(https?:)?\/\//i.test(href)) return false
  if (/^(mailto|tel|vscode):/i.test(href)) return false
  return true
}

export function isInlineFilePath(value: string): boolean {
  const trimmed = value.trim()
  if (!PATH_EXT_RE.test(trimmed)) return false
  const ext = trimmed.split('.').pop()?.toLowerCase() ?? ''
  return MARKDOWN_EXTS.has(ext) || CODE_EXTS.has(ext) || IMAGE_EXTS.has(ext)
}

export function openFileViewer(
  panel: Pick<RightPanelContextValue, 'openRightPanel' | 'closeRightPanel'>,
  taskId: string,
  path: string,
): void {
  panel.openRightPanel(
    `file:${taskId}:${path}`,
    <FileViewer taskId={taskId} path={path} onClose={panel.closeRightPanel} />,
    {
      width: '800px',
    },
  )
}

export const FileViewer: FC<FileViewerProps> = ({ taskId, path, embedded = false, onClose }) => {
  const query = useQuery<FileResponse>({
    queryKey: ['file-viewer', taskId, path],
    queryFn: () => restClient.get<FileResponse>(`/tasks/${taskId}/file?path=${encodeURIComponent(path)}`),
    retry: false,
  })

  const notFound = query.error instanceof ApiError && query.error.status === 404
  const title = path
  const ext = query.data?.ext ?? extensionOf(path)
  const isImage = IMAGE_EXTS.has(ext)

  return (
    <div
      className="paper-panel"
      style={{
        width: embedded ? '100%' : 800,
        maxWidth: embedded ? '100%' : 'min(800px, calc(100vw - 48px))',
        height: '100%',
        minHeight: 0,
        borderRadius: 0,
        border: 'none',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {!embedded && (
        <div
          className="paper-head"
          style={{
            padding: '12px 16px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <div className="paper-head-title" style={{ minWidth: 0 }}>
            <span style={{ color: 'var(--paper-deep)' }}>file</span>
            <span className="ab-tabular" style={{ marginLeft: 8, wordBreak: 'break-all' }}>
              {title}
            </span>
          </div>
          {onClose && (
            <button type="button" onClick={onClose} aria-label="关闭" className="paper-close">
              ×
            </button>
          )}
        </div>
      )}
      <div
        className="paper-body"
        style={{
          padding: 16,
          overflow: 'auto',
          flex: 1,
          minHeight: 0,
        }}
      >
        {query.isLoading && <Muted>loading…</Muted>}
        {notFound && <Muted>文件不存在</Muted>}
        {query.isError && !notFound && <Muted>读取失败：{query.error.message}</Muted>}
        {query.data && (
          <FileBody
            taskId={taskId}
            path={path}
            file={query.data}
            ext={ext}
            isImage={isImage}
          />
        )}
      </div>
    </div>
  )
}

const FileBody: FC<{
  taskId: string
  path: string
  file: FileResponse
  ext: string
  isImage: boolean
}> = ({ taskId, path, file, ext, isImage }) => {
  if (isImage) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Meta file={file} />
        <img
          src={rawFileUrl(taskId, path)}
          alt={path}
          style={{ maxWidth: '100%', height: 'auto', objectFit: 'contain' }}
        />
      </div>
    )
  }

  if (file.binary) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Meta file={file} />
        <Muted>二进制文件，不支持预览</Muted>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <Meta file={file} />
      {file.truncated && <Muted>内容超过 256KB，已截断预览。</Muted>}
      {MARKDOWN_EXTS.has(ext) ? (
        <MarkdownSurface>{file.content}</MarkdownSurface>
      ) : CODE_EXTS.has(ext) ? (
        <MarkdownSurface>{`\`\`\`${languageFor(ext)}\n${file.content}\n\`\`\``}</MarkdownSurface>
      ) : (
        <pre
          style={{
            margin: 0,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            fontSize: 12,
            lineHeight: 1.6,
          }}
        >
          {file.content}
        </pre>
      )}
    </div>
  )
}

const Meta: FC<{ file: FileResponse }> = ({ file }) => (
  <div className="ab-tabular" style={{ fontSize: 11, color: 'var(--ink-brown-d)' }}>
    {file.root} · .{file.ext || 'file'}
  </div>
)

const Muted: FC<{ children: ReactNode }> = ({ children }) => (
  <div style={{ color: 'var(--ink-brown-d)', fontSize: 13, fontStyle: 'italic' }}>{children}</div>
)

const MarkdownSurface: FC<{ children: string }> = ({ children }) => (
  <div style={{ fontSize: 13, lineHeight: 1.65, color: 'var(--ink-brown)' }}>
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} rehypePlugins={[rehypeHighlight]}>
      {children}
    </ReactMarkdown>
  </div>
)

function rawFileUrl(taskId: string, filePath: string): string {
  const params = new URLSearchParams({ path: filePath, raw: '1' })
  if (env.token) params.set('token', env.token)
  return `${env.apiBase}/tasks/${taskId}/file?${params.toString()}`
}

function extensionOf(filePath: string): string {
  return filePath.split('.').pop()?.toLowerCase() ?? ''
}

function languageFor(ext: string): string {
  if (ext === 'tsx' || ext === 'jsx') return ext
  if (ext === 'yml') return 'yaml'
  if (ext === 'sh') return 'bash'
  if (ext === 'mdx') return 'md'
  return ext
}
