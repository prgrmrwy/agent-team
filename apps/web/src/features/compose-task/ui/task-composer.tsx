import {
  useState,
  useRef,
  useMemo,
  useEffect,
  type FC,
  type KeyboardEvent,
} from 'react'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { restClient } from '../../../shared/api/index.js'
import type {
  Project,
  CreateTaskRequest,
  CreateTaskResponse,
  TaskBootstrapConfig,
  BootstrapProvider,
  BootstrapMode,
  BootstrapReleasePolicy,
} from '@agent-team/protocol'

interface BootstrapCombo {
  value: string
  label: string
  provider: BootstrapProvider
  mode?: BootstrapMode
}

const BOOTSTRAP_COMBOS: BootstrapCombo[] = [
  { value: 'generic-pnpm:lean', label: 'generic-pnpm / lean', provider: 'generic-pnpm', mode: 'lean' },
  { value: 'generic-pnpm:full', label: 'generic-pnpm / full', provider: 'generic-pnpm', mode: 'full' },
  { value: 'sw:lean', label: 'sw / lean', provider: 'sw', mode: 'lean' },
  { value: 'sw:full', label: 'sw / full', provider: 'sw', mode: 'full' },
  { value: 'none', label: 'none(不准备 worktree)', provider: 'none' },
]
function comboKey(p: BootstrapProvider, m?: BootstrapMode): string {
  if (p === 'none') return 'none'
  return `${p}:${m ?? 'lean'}`
}
function comboLabelFor(p: BootstrapProvider, m?: BootstrapMode): string {
  const c = BOOTSTRAP_COMBOS.find((x) => x.value === comboKey(p, m))
  return c?.label ?? `${p}${m ? ' / ' + m : ''}`
}

function shortPath(p: string): string {
  // ~ 替换 home（/Users/<name> 或 /home/<name>），过长截取尾段
  const t = p.replace(/^\/(?:Users|home)\/[^/]+/, '~')
  return t.length > 26 ? '…' + t.slice(t.length - 25) : t
}

const RELEASE_OPTIONS: { value: BootstrapReleasePolicy; label: string }[] = [
  { value: 'remove-if-clean', label: 'remove-if-clean(默认,clean 则删)' },
  { value: 'retain', label: 'retain(总是保留)' },
  { value: 'archive', label: 'archive(打 tag 后保留)' },
  { value: 'prompt', label: 'prompt(每次问 planner)' },
]

interface BootstrapConfigResponse {
  present: boolean
  config?: TaskBootstrapConfig
  suggestion?: TaskBootstrapConfig
  reason?: string
}

interface SkillMeta {
  name: string
  description: string
}

/**
 * Codex 风中心输入框 — M3 T2(+ T2 反馈调整后)首页主组件
 *
 * - 大 textarea(自动 grow)写任务描述
 * - 输入 `/` 触发 **slash command** picker(目前只 /skill 类,选了的 skill
 *   作 planner hint 注入 description 前缀)
 * - 下方:project dropdown + 发送按钮
 * - **不带链接输入** — URL 直接写文本里,planner 自取
 * - **不强制 title / contextLinks** — server 端从 description 推断 title
 * - Cmd/Ctrl+Enter 提交
 */
export const TaskComposer: FC = () => {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  // sidebar 的 "+ for project X" 走 /?project=<id>;预选目标项目
  const search = useSearch({ strict: false }) as { project?: string }
  const presetProjectId = search.project

  const { data: projects = [] } = useQuery<Project[]>({
    queryKey: ['projects'],
    queryFn: () => restClient.get<Project[]>('/projects'),
  })
  const { data: skills = [] } = useQuery<SkillMeta[]>({
    queryKey: ['skills'],
    queryFn: () => restClient.get<SkillMeta[]>('/skills'),
  })

  const [description, setDescription] = useState('')
  const [projectId, setProjectId] = useState<string>('')
  const [selectedSkills, setSelectedSkills] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [showSkillPicker, setShowSkillPicker] = useState(false)
  const [skillFilter, setSkillFilter] = useState('')
  const [skillHover, setSkillHover] = useState(0) // 键盘高亮索引
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const skillItemRefs = useRef<Record<number, HTMLButtonElement | null>>({})
  const submitInFlightRef = useRef(false)
  const hasDescription = description.trim().length > 0
  const currentProject = projects.find((p) => p.id === projectId)

  // 优先用 URL search 预选,否则默认选第一个项目(若有)
  useEffect(() => {
    if (projectId) return
    if (presetProjectId && projects.some((p) => p.id === presetProjectId)) {
      setProjectId(presetProjectId)
      return
    }
    if (projects.length > 0 && projects[0]) {
      setProjectId(projects[0].id)
    }
  }, [projects, projectId, presetProjectId])

  // bootstrap config:按 projectId 拉取(有就用;没就用 server discovery 建议)
  const { data: bootstrapData } = useQuery<BootstrapConfigResponse>({
    queryKey: ['bootstrap-config', projectId],
    queryFn: () =>
      restClient.get<BootstrapConfigResponse>(
        `/projects/${encodeURIComponent(projectId)}/bootstrap-config`,
      ),
    enabled: !!projectId,
  })
  // bootstrap 现行配置:存了用存的,没存用 server discover 的,都没有用 safe default。
  const effectiveBootstrap: TaskBootstrapConfig = bootstrapData?.config ??
    bootstrapData?.suggestion ?? {
      provider: 'generic-pnpm',
      mode: 'lean',
      release: 'remove-if-clean',
      options: {},
    }

  // 落盘:本地选了之后立刻持久化(后续任务自动用)
  const saveBootstrap = useMutation({
    mutationFn: (next: TaskBootstrapConfig) =>
      restClient.put<{ ok: true; config: TaskBootstrapConfig }>(
        `/projects/${encodeURIComponent(projectId)}/bootstrap-config`,
        next,
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bootstrap-config', projectId] })
    },
  })
  function updateBootstrap(patch: Partial<TaskBootstrapConfig>) {
    const merged: TaskBootstrapConfig = { ...effectiveBootstrap, ...patch }
    // provider=none 时强制清空 mode
    if (merged.provider === 'none') merged.mode = undefined
    saveBootstrap.mutate(merged)
  }

  // textarea 自动撑高
  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 320)}px`
  }, [description])

  const filteredSkills = useMemo(() => {
    if (!skillFilter) return skills
    const q = skillFilter.toLowerCase()
    return skills.filter((s) => s.name.toLowerCase().includes(q))
  }, [skills, skillFilter])

  // 高亮重置:filter 变 / picker 开关变 → 回到第一项
  useEffect(() => {
    setSkillHover(0)
  }, [skillFilter, showSkillPicker])

  useEffect(() => {
    if (!showSkillPicker) return
    skillItemRefs.current[skillHover]?.scrollIntoView({ block: 'nearest' })
  }, [showSkillPicker, skillHover])

  const mutation = useMutation<CreateTaskResponse, Error, CreateTaskRequest>({
    mutationFn: (data) => restClient.post<CreateTaskResponse>('/tasks', data),
    onSuccess: (task) => {
      submitInFlightRef.current = false
      queryClient.invalidateQueries({ queryKey: ['tasks'] })
      navigate({ to: '/tasks/$taskId', params: { taskId: task.id } })
    },
    onError: (err) => {
      submitInFlightRef.current = false
      setError(err.message || '创建任务失败')
    },
  })

  function handleChange(value: string) {
    setError(null)
    setDescription(value)
    // `/` 触发 slash command(单词级:行首或前面是空白时才触发)
    const ta = textareaRef.current
    if (!ta) return
    const caret = ta.selectionStart
    const before = value.slice(0, caret)
    const slashMatch = before.match(/(?:^|\s)\/([a-z0-9-]*)$/i)
    if (slashMatch) {
      setShowSkillPicker(true)
      setSkillFilter(slashMatch[1] ?? '')
    } else {
      setShowSkillPicker(false)
    }
  }

  function pickSkill(skillName: string) {
    if (!selectedSkills.includes(skillName)) {
      setSelectedSkills((prev) => [...prev, skillName])
    }
    // 从 description 里移除 `/partial` 文字(包括开头的空白也别带过来)
    const ta = textareaRef.current
    if (ta) {
      const caret = ta.selectionStart
      const before = description.slice(0, caret).replace(/(\s?)\/[a-z0-9-]*$/i, '$1')
      const after = description.slice(caret)
      setDescription(before + after)
      setTimeout(() => {
        ta.focus()
        ta.setSelectionRange(before.length, before.length)
      }, 0)
    }
    setShowSkillPicker(false)
    setSkillFilter('')
  }

  function removeSkill(skillName: string) {
    setSelectedSkills((prev) => prev.filter((s) => s !== skillName))
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // picker 打开时优先吃键(↑↓ 移动 / Enter 选中 / Esc 关)
    if (showSkillPicker && filteredSkills.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSkillHover((h) => (h + 1) % filteredSkills.length) // 末尾→头部
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSkillHover((h) => (h - 1 + filteredSkills.length) % filteredSkills.length) // 头部→末尾
        return
      }
      if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        const target = filteredSkills[skillHover] ?? filteredSkills[0]
        if (target) pickSkill(target.name)
        return
      }
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      handleSubmit()
    }
    if (e.key === 'Escape' && showSkillPicker) {
      setShowSkillPicker(false)
    }
  }

  function handleSubmit() {
    if (submitInFlightRef.current || mutation.isPending) return
    setError(null)
    const trimmed = description.trim()
    if (!trimmed) {
      setError('请先描述想做什么')
      return
    }

    // skills 作为 planner hint 注入 description 前缀
    const skillsLine =
      selectedSkills.length > 0
        ? `[用户标的 skill hint(给 planner 参考):${selectedSkills.map((s) => `/${s}`).join(' ')}]\n\n`
        : ''

    submitInFlightRef.current = true
    mutation.mutate({
      projectId: projectId || undefined,
      description: skillsLine + trimmed,
      contextLinks: [],
      // 显式带 bootstrap override(yaml 已存,这里再 inline 一次,避免 yaml IO race)
      bootstrap: effectiveBootstrap,
    })
  }

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
        gap: 16,
      }}
    >
      <div style={{ width: '100%', maxWidth: 680 }}>
        <h1
          style={{
            fontSize: 18,
            fontWeight: 500,
            color: 'var(--ink-soft)',
            textAlign: 'center',
            marginBottom: 24,
            letterSpacing: '0.05em',
          }}
        >
          ➤ 我们应该在 agent-team 中构建什么?
        </h1>

        {/* skill chips */}
        {selectedSkills.length > 0 && (
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 6,
              marginBottom: 8,
              padding: '0 4px',
            }}
          >
            {selectedSkills.map((s) => (
              <SkillChip key={s} name={s} onRemove={() => removeSkill(s)} />
            ))}
          </div>
        )}

        {/* 输入框容器 */}
        <div
          style={{
            position: 'relative',
            background: 'var(--slate-surface)',
            border: '1px solid var(--slate-edge)',
            borderRadius: 2,
            transition: 'border-color 120ms, box-shadow 120ms',
          }}
          onFocusCapture={(e) => {
            ;(e.currentTarget as HTMLElement).style.borderColor = 'var(--cyan)'
            ;(e.currentTarget as HTMLElement).style.boxShadow = '0 0 12px var(--cyan-glow)'
          }}
          onBlurCapture={(e) => {
            ;(e.currentTarget as HTMLElement).style.borderColor = 'var(--slate-edge)'
            ;(e.currentTarget as HTMLElement).style.boxShadow = 'none'
          }}
        >
          <textarea
            ref={textareaRef}
            value={description}
            onChange={(e) => handleChange(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={3}
            placeholder="想到啥写啥,planner 会跟你对齐。/ 选 skill 给 planner 提示。链接、ID、上下文直接贴文本里。Cmd+Enter 发送。"
            style={{
              width: '100%',
              minHeight: 80,
              maxHeight: 320,
              padding: '14px 16px',
              border: 'none',
              outline: 'none',
              background: 'transparent',
              color: 'var(--ink-white)',
              fontSize: 13,
              fontFamily: 'var(--font-chrome)',
              lineHeight: 1.6,
              resize: 'none',
            }}
          />

          {/* action bar 底栏 */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '8px 12px',
              borderTop: '1px solid var(--slate-edge)',
              background: 'var(--slate-bg)',
            }}
          >
            <SelectChip
              label={
                projects.find((p) => p.id === projectId)?.name ?? projectId ?? '选择项目'
              }
              options={projects.map((p) => ({ value: p.id, label: p.name }))}
              onSelect={setProjectId}
              icon="📁"
            />
            <SelectChip
              label={comboLabelFor(effectiveBootstrap.provider, effectiveBootstrap.mode)}
              options={BOOTSTRAP_COMBOS.map((c) => ({ value: c.value, label: c.label }))}
              onSelect={(v) => {
                const c = BOOTSTRAP_COMBOS.find((x) => x.value === v)
                if (c) updateBootstrap({ provider: c.provider, mode: c.mode })
              }}
              icon="⚙"
            />
            {effectiveBootstrap.provider !== 'none' && (
              <SelectChip
                label={effectiveBootstrap.release}
                options={RELEASE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
                onSelect={(v) => updateBootstrap({ release: v as BootstrapReleasePolicy })}
                icon="♻"
              />
            )}
            {effectiveBootstrap.provider !== 'none' && currentProject?.repoPath && (
              <span
                title={`bootstrap 仓库根目录(由 project.repoPath 决定):${currentProject.repoPath}`}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '4px 10px',
                  fontSize: 11,
                  fontFamily: 'var(--font-chrome)',
                  color: 'var(--ink-dim)',
                  border: '1px dashed var(--slate-edge)',
                  borderRadius: 2,
                  maxWidth: 240,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                <span style={{ fontSize: 10 }}>📂</span>
                {shortPath(currentProject.repoPath)}
              </span>
            )}
            <div style={{ flex: 1 }} />

            <SendButton
              onClick={handleSubmit}
              disabled={!hasDescription || mutation.isPending}
              pending={mutation.isPending}
            />
          </div>

          {/* /skill picker dropdown */}
          {showSkillPicker && (
            <div
              style={{
                position: 'absolute',
                bottom: '100%',
                left: 12,
                marginBottom: 4,
                background: 'var(--slate-elev)',
                border: '1px solid var(--cyan-dim)',
                borderRadius: 2,
                width: 360,
                maxHeight: 280,
                overflowY: 'auto',
                boxShadow: '0 4px 16px rgba(0,0,0,0.5), 0 0 8px var(--cyan-glow)',
                zIndex: 20,
              }}
            >
              <div
                className="ab-eyebrow"
                style={{
                  padding: '8px 12px',
                  borderBottom: '1px solid var(--slate-edge)',
                  color: 'var(--cyan)',
                }}
              >
                / slash · skill picker {skillFilter && `· "${skillFilter}"`}
              </div>
              {filteredSkills.length === 0 && (
                <div style={{ padding: 12, fontSize: 11, color: 'var(--ink-dim)' }}>
                  无匹配 skill
                </div>
              )}
              {filteredSkills.map((s, idx) => {
                const isActive = idx === skillHover
                return (
                  <button
                    key={s.name}
                    ref={(el) => {
                      skillItemRefs.current[idx] = el
                    }}
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseMove={() => {
                      // 鼠标移上同步键盘高亮(避免键鼠混用时高亮跳)
                      if (idx !== skillHover) setSkillHover(idx)
                    }}
                    onClick={() => pickSkill(s.name)}
                    style={{
                      display: 'block',
                      width: '100%',
                      textAlign: 'left',
                      background: isActive ? 'rgba(91,200,221,0.15)' : 'transparent',
                      borderTop: 'none',
                      borderRight: 'none',
                      borderBottom: 'none',
                      borderLeft: `2px solid ${isActive ? 'var(--cyan)' : 'transparent'}`,
                      color: 'var(--ink-white)',
                      padding: '6px 12px 6px 10px',
                      cursor: 'pointer',
                      fontFamily: 'var(--font-chrome)',
                    }}
                  >
                    <div
                      style={{
                        fontSize: 12,
                        color: isActive ? 'var(--cyan-bright)' : 'var(--cyan)',
                        textShadow: isActive ? '0 0 4px var(--cyan-glow)' : 'none',
                      }}
                    >
                      /{s.name}
                    </div>
                    {s.description && (
                      <div
                        style={{
                          fontSize: 10,
                          color: 'var(--ink-dim)',
                          marginTop: 2,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {s.description}
                      </div>
                    )}
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {/* 错误提示 */}
        {error && (
          <div
            style={{
              marginTop: 12,
              padding: '8px 12px',
              background: 'rgba(184,58,90,0.12)',
              border: '1px solid var(--malice)',
              color: 'var(--malice)',
              fontSize: 11,
              borderRadius: 2,
            }}
          >
            {error}
          </div>
        )}

        <p
          style={{
            marginTop: 16,
            fontSize: 10,
            color: 'var(--ink-dim)',
            textAlign: 'center',
            letterSpacing: '0.05em',
          }}
        >
          / 选 skill · Cmd/Ctrl+Enter 发送 · planner 会先与你对齐再招 engineer
        </p>
      </div>
    </div>
  )
}

const SkillChip: FC<{ name: string; onRemove: () => void }> = ({ name, onRemove }) => (
  <span
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      padding: '3px 8px',
      background: 'rgba(91,200,221,0.12)',
      border: '1px solid var(--cyan-dim)',
      color: 'var(--cyan-bright)',
      fontSize: 11,
      letterSpacing: '0.05em',
      borderRadius: 2,
    }}
  >
    <span>/{name}</span>
    <button
      type="button"
      onClick={onRemove}
      aria-label={`移除 ${name}`}
      style={{
        background: 'transparent',
        border: 'none',
        color: 'var(--ink-dim)',
        cursor: 'pointer',
        padding: 0,
        fontSize: 11,
        lineHeight: 1,
      }}
    >
      ×
    </button>
  </span>
)

const SelectChip: FC<{
  label: string
  options: { value: string; label: string }[]
  onSelect: (v: string) => void
  icon?: string
}> = ({ label, options, onSelect, icon }) => {
  const [open, setOpen] = useState(false)
  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          background: 'transparent',
          border: '1px solid var(--slate-edge)',
          color: 'var(--ink-soft)',
          padding: '4px 10px',
          fontSize: 11,
          cursor: 'pointer',
          borderRadius: 2,
          fontFamily: 'var(--font-chrome)',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
        }}
      >
        {icon && <span style={{ fontSize: 10 }}>{icon}</span>}
        <span>{label}</span>
        <span style={{ opacity: 0.5 }}>▾</span>
      </button>
      {open && (
        <>
          <div
            onClick={() => setOpen(false)}
            style={{ position: 'fixed', inset: 0, zIndex: 19 }}
          />
          <div
            style={{
              position: 'absolute',
              top: '100%',
              left: 0,
              marginTop: 4,
              minWidth: 160,
              background: 'var(--slate-elev)',
              border: '1px solid var(--cyan-dim)',
              borderRadius: 2,
              zIndex: 20,
              boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
            }}
          >
            {options.length === 0 && (
              <div style={{ padding: 8, fontSize: 11, color: 'var(--ink-dim)' }}>(无)</div>
            )}
            {options.map((o) => (
              <button
                key={o.value}
                type="button"
                onClick={() => {
                  onSelect(o.value)
                  setOpen(false)
                }}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--ink-white)',
                  padding: '6px 12px',
                  cursor: 'pointer',
                  fontSize: 11,
                  fontFamily: 'var(--font-chrome)',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'rgba(91,200,221,0.1)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent'
                }}
              >
                {o.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

const SendButton: FC<{ onClick: () => void; disabled?: boolean; pending?: boolean }> = ({
  onClick,
  disabled,
  pending,
}) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    aria-label="发送"
    style={{
      background: disabled
        ? 'rgba(91,200,221,0.05)'
        : 'linear-gradient(180deg, rgba(91,200,221,0.18), rgba(91,200,221,0.06))',
      border: `1px solid ${disabled ? 'var(--slate-edge)' : 'var(--cyan)'}`,
      color: disabled ? 'var(--ink-dimmer)' : 'var(--cyan-bright)',
      padding: '6px 14px',
      fontSize: 11,
      fontWeight: 600,
      textTransform: 'uppercase',
      letterSpacing: '0.2em',
      cursor: disabled ? 'not-allowed' : 'pointer',
      borderRadius: 2,
      boxShadow: disabled ? 'none' : '0 0 12px var(--cyan-glow)',
      fontFamily: 'var(--font-chrome)',
    }}
  >
    {pending ? '…' : '发送 ↑'}
  </button>
)
