import { useRef, useState, type FC, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '../../../shared/ui/button.js'
import { restClient } from '../../../shared/api/index.js'
import type { CreateTaskRequest, CreateTaskResponse, ListProjectsResponse } from '@agent-team/protocol'

interface CreateTaskFormProps {
  onSuccess?: (task: CreateTaskResponse) => void
}

export const CreateTaskForm: FC<CreateTaskFormProps> = ({ onSuccess }) => {
  const queryClient = useQueryClient()
  const submitInFlightRef = useRef(false)

  const { data: projects = [] } = useQuery<ListProjectsResponse>({
    queryKey: ['projects'],
    queryFn: () => restClient.get<ListProjectsResponse>('/projects'),
  })

  const [projectId, setProjectId] = useState('')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [contextLinks, setContextLinks] = useState([{ url: '', label: '' }])
  const [errors, setErrors] = useState<Record<string, string>>({})

  const mutation = useMutation({
    mutationFn: (data: CreateTaskRequest) =>
      restClient.post<CreateTaskResponse>('/tasks', data),
    onSuccess: (task) => {
      submitInFlightRef.current = false
      queryClient.invalidateQueries({ queryKey: ['tasks'] })
      onSuccess?.(task)
    },
    onError: () => {
      submitInFlightRef.current = false
    },
  })

  function validate(): boolean {
    const e: Record<string, string> = {}
    if (!projectId) e.projectId = '请选择项目'
    if (!title.trim()) e.title = '标题不能为空'
    if (!description.trim()) e.description = '描述不能为空'
    const validLinks = contextLinks.filter((l) => l.url.trim())
    if (validLinks.length === 0) e.contextLinks = '至少填写 1 条上下文链接'
    else {
      for (const l of validLinks) {
        try {
          new URL(l.url)
        } catch {
          e.contextLinks = `链接格式无效：${l.url}`
          break
        }
      }
    }
    setErrors(e)
    return Object.keys(e).length === 0
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (submitInFlightRef.current || mutation.isPending) return
    if (!validate()) return
    const validLinks = contextLinks
      .filter((l) => l.url.trim())
      .map((l) => ({ url: l.url.trim(), label: l.label.trim() || undefined }))
    submitInFlightRef.current = true
    mutation.mutate({ projectId, title: title.trim(), description: description.trim(), contextLinks: validLinks })
  }

  function addLink() {
    setContextLinks((prev) => [...prev, { url: '', label: '' }])
  }

  function removeLink(idx: number) {
    setContextLinks((prev) => prev.filter((_, i) => i !== idx))
  }

  function updateLink(idx: number, field: 'url' | 'label', value: string) {
    setContextLinks((prev) => prev.map((l, i) => (i === idx ? { ...l, [field]: value } : l)))
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      {/* 项目选择 */}
      <div>
        <label className="mb-1 block text-sm font-medium">项目</label>
        <select
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="">选择项目...</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        {errors.projectId && <p className="mt-1 text-xs text-destructive">{errors.projectId}</p>}
      </div>

      {/* 标题 */}
      <div>
        <label className="mb-1 block text-sm font-medium">标题</label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="用一句话描述这个任务"
          className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
        {errors.title && <p className="mt-1 text-xs text-destructive">{errors.title}</p>}
      </div>

      {/* 描述 */}
      <div>
        <label className="mb-1 block text-sm font-medium">描述</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={4}
          placeholder="详细描述任务背景、目标和约束..."
          className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-none"
        />
        {errors.description && <p className="mt-1 text-xs text-destructive">{errors.description}</p>}
      </div>

      {/* 上下文链接 */}
      <div>
        <label className="mb-1 block text-sm font-medium">上下文链接（至少 1 条）</label>
        <div className="flex flex-col gap-2">
          {contextLinks.map((link, idx) => (
            <div key={idx} className="flex gap-2">
              <input
                type="url"
                value={link.url}
                onChange={(e) => updateLink(idx, 'url', e.target.value)}
                placeholder="https://..."
                className="flex-1 rounded-md border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
              <input
                type="text"
                value={link.label}
                onChange={(e) => updateLink(idx, 'label', e.target.value)}
                placeholder="标签（可选）"
                className="w-32 rounded-md border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
              {contextLinks.length > 1 && (
                <button
                  type="button"
                  onClick={() => removeLink(idx)}
                  className="text-muted-foreground hover:text-destructive text-sm"
                >
                  删除
                </button>
              )}
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={addLink}
          className="mt-1 text-xs text-primary hover:underline"
        >
          + 添加链接
        </button>
        {errors.contextLinks && <p className="mt-1 text-xs text-destructive">{errors.contextLinks}</p>}
      </div>

      {mutation.isError && (
        <p className="text-sm text-destructive">
          创建失败：{(mutation.error as Error).message}
        </p>
      )}

      <Button type="submit" disabled={mutation.isPending}>
        {mutation.isPending ? '创建中...' : '开始任务'}
      </Button>
    </form>
  )
}
