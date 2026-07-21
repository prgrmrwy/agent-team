import { beforeAll, describe, expect, it, vi } from 'vitest'
import { isValidElement } from 'react'
import type { worktreeVscodeHref } from './bootstrap-progress.js'

let worktreeVscodeHrefFn: typeof worktreeVscodeHref

beforeAll(async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const mod = await import('./bootstrap-progress.js')
  worktreeVscodeHrefFn = mod.worktreeVscodeHref
})

describe('ResourceSummary rendering', () => {
  it('links only the worktree path, not the status summary text', async () => {
    const { ResourceSummaryForTest } = await import('./bootstrap-progress.js')
    const element = ResourceSummaryForTest({
      resource: {
        id: 'primary-worktree',
        taskId: 'task-1',
        kind: 'worktree',
        status: 'needs-review',
        provider: 'sw',
        mode: 'lean',
        path: '/tmp/worktree',
        summary: '/tmp/worktree: sw 未自动 clean',
        attempts: 1,
        createdAt: '2026-06-28T00:00:00.000Z',
        updatedAt: '2026-06-28T00:00:00.000Z',
      },
      isFailed: false,
    })

    expect(isValidElement(element)).toBe(true)
    if (!isValidElement(element)) throw new Error('expected ResourceSummary to return a React element')
    const children = (element.props as { children: unknown[] }).children
    const pathLink = children[0]
    expect(isValidElement(pathLink)).toBe(true)
    if (!isValidElement(pathLink)) throw new Error('expected first child to be a React element')
    expect(pathLink.type).toBe('a')
    expect((pathLink.props as { children: unknown }).children).toBe('/tmp/worktree')
    expect(children[1]).toBe(': sw 未自动 clean')
  })
})

describe('worktreeVscodeHref', () => {
  it('opens any worktree resource with a path, including needs-review resources', () => {
    expect(worktreeVscodeHrefFn({ kind: 'worktree', path: '/tmp/work tree' })).toBe(
      'vscode://file//tmp/work%20tree',
    )
  })

  it('does not create vscode links when the worktree path is missing', () => {
    expect(worktreeVscodeHrefFn({ kind: 'worktree', path: undefined })).toBeNull()
  })
})
